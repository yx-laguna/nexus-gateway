/**
 * product-db.ts
 *
 * Read-only query layer over the pre-built SQLite product catalog (see
 * scripts/build-products-db.py), generated offline from Shopee/iHerb affiliate
 * datafeed CSVs. Used by product-search.ts's Stage A (local-first search) to
 * build a candidate pool before ever calling Kimi to rank/select.
 *
 * Same hosting pattern as agoda-db.ts: the .sqlite file lives on a persistent
 * Render disk (see render.yaml), not in git.
 *
 * Schema is merchant-agnostic (a `merchant` + `country` column, not a
 * separate table per source) so search/ranking code never needs to know
 * which merchants exist — adding Lazada/another Shopee country later is
 * purely an ingestion-script change, not a query-layer one.
 */

import { DatabaseSync } from "node:sqlite";

export interface ProductRow {
  id: number;
  merchant: string; // "shopee" | "iherb"
  country: string; // ISO alpha-2, e.g. "MY", "SG"
  product_id: string;
  shop_id: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  brand: string | null;
  price: number | null;
  sale_price: number | null;
  currency: string | null;
  rating: number | null;
  sold_count: number | null;
  stock: number | null;
  is_official: number | null; // 0/1
  is_preferred: number | null; // 0/1
  image_url: string | null;
  product_url: string | null; // raw canonical URL — NOT a pre-wrapped tracking link
  last_updated: number | null;
}

const DB_PATH = process.env.PRODUCTS_DB_PATH ?? "./products.sqlite";

let _db: DatabaseSync | null = null;
let _openFailed = false;

function getDb(): DatabaseSync {
  if (_db) return _db;
  if (_openFailed) throw new Error(`[product-db] previously failed to open ${DB_PATH}`);
  try {
    _db = new DatabaseSync(DB_PATH, { readOnly: true });
    console.log(`[product-db] opened ${DB_PATH}`);
    return _db;
  } catch (err) {
    _openFailed = true;
    throw err;
  }
}

/** Best-effort availability check — lets callers degrade gracefully (fall back to the
 *  generic Laguna merchant-mint flow instead of local product search). */
export function isProductsDbAvailable(): boolean {
  try {
    getDb();
    return true;
  } catch (err) {
    console.warn(`[product-db] unavailable — local product search will be skipped:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Close the cached read-only handle and forget any cached lookups, so the next
 * query re-opens PRODUCTS_DB_PATH from disk. Called by product-refresh.ts right
 * after it atomically swaps a freshly-rebuilt file into place — without this,
 * this process would keep querying the old (now-unlinked-by-rename) inode
 * forever, since node:sqlite doesn't watch the file for changes on its own.
 */
export function reopenProductsDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch (err) {
      console.warn(`[product-db] error closing stale handle (ignoring):`, err instanceof Error ? err.message : err);
    }
  }
  _db = null;
  _openFailed = false;
  catalogCache.clear();
  console.log(`[product-db] reopened — will re-read ${DB_PATH} on next query`);
}

// Cache hasLocalCatalog results — this gets checked on every message for every
// category, and the underlying table never changes within a process lifetime
// (a rebuild+redeploy would restart the process anyway).
const catalogCache = new Map<string, boolean>();

/** Does the local catalog have ANY rows for this merchant+country combo? Used by
 *  agent.ts to decide whether a category should get the local search treatment or
 *  fall through to the existing generic Laguna-merchant-mint flow unchanged. */
export function hasLocalCatalog(merchant: string, country: string | null | undefined): boolean {
  if (!country) return false;
  const key = `${merchant}:${country.toUpperCase()}`;
  const cached = catalogCache.get(key);
  if (cached !== undefined) return cached;

  let result = false;
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT 1 FROM products WHERE merchant = ? AND country = ? LIMIT 1`)
      .get(merchant, country.toUpperCase());
    result = !!row;
  } catch {
    result = false;
  }
  catalogCache.set(key, result);
  return result;
}

/**
 * Stage A candidate pool — FTS5 keyword match, filtered to merchant(s)+country,
 * ordered by bm25 text-relevance. Callers (product-search.ts) apply their own
 * popularity/trust heuristic re-sort and cap on top of this — this layer's job is
 * just "find plausibly-relevant rows fast", same division of responsibility as
 * agoda-db.ts's searchHotelsByCityId (raw DB pull) vs agoda-search.ts (scoring).
 */
export function searchProductCandidates(params: {
  query: string;
  country: string;
  merchants?: string[]; // restrict to these merchants; omit = search all
  inStockOnly?: boolean;
  limit?: number;
}): ProductRow[] {
  const db = getDb();
  const limit = params.limit ?? 200;

  const merchantFilter = params.merchants?.length
    ? `AND p.merchant IN (${params.merchants.map(() => "?").join(",")})`
    : "";
  const stockFilter = params.inStockOnly ? `AND (p.stock IS NULL OR p.stock > 0)` : "";

  const stmt = db.prepare(`
    SELECT p.* FROM products p
    JOIN products_fts ON products_fts.rowid = p.id
    WHERE products_fts MATCH ?
      AND p.country = ?
      ${merchantFilter}
      ${stockFilter}
    ORDER BY bm25(products_fts)
    LIMIT ?
  `);

  const args: (string | number)[] = [ftsQuery(params.query), params.country.toUpperCase()];
  if (params.merchants?.length) args.push(...params.merchants);
  args.push(limit);

  return stmt.all(...args) as unknown as ProductRow[];
}

/** Name/title search within a country — used when the shopper names a specific
 *  product that isn't (or is no longer) part of the currently active search results,
 *  mirroring agoda-db.ts's searchHotelsByNameInCity. */
export function searchProductsByTitle(params: {
  nameQuery: string;
  country: string;
  merchants?: string[];
  limit?: number;
}): ProductRow[] {
  const db = getDb();
  const limit = params.limit ?? 5;
  const merchantFilter = params.merchants?.length
    ? `AND merchant IN (${params.merchants.map(() => "?").join(",")})`
    : "";
  const stmt = db.prepare(`
    SELECT * FROM products
    WHERE country = ? AND title LIKE ? ${merchantFilter}
    ORDER BY (rating IS NOT NULL) DESC, rating DESC, sold_count DESC
    LIMIT ?
  `);
  const args: (string | number)[] = [params.country.toUpperCase(), `%${params.nameQuery}%`];
  if (params.merchants?.length) args.push(...params.merchants);
  args.push(limit);
  return stmt.all(...args) as unknown as ProductRow[];
}

// FTS5's MATCH syntax treats bare punctuation/operators specially (AND/OR/NOT, -,
// etc.) — a shopper's free-text query ("toothbrush?", "vitamin c + zinc") could
// otherwise throw a syntax error instead of just searching. Strip anything that
// isn't a word character/space and let FTS5's default implicit-AND-of-terms handle
// the rest.
function ftsQuery(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `${term}*`) // prefix match — "tooth" should still surface "toothbrush"
    .join(" ");
  return cleaned.length > 0 ? cleaned : raw;
}
