/**
 * product-search.ts
 *
 * Local-first retail product search — the Shopee/iHerb equivalent of
 * agoda-search.ts's Stage A. There's no Stage B here (no live-price-check API
 * the way Agoda has one for hotels): the datafeed's own price IS what we show,
 * refreshed whenever the catalog is re-ingested (see scripts/build-products-db.py).
 *
 *   1. FTS5 keyword search against the local catalog (product-db.ts), scoped to
 *      the shopper's country — a query like "toothbrush" can match thousands of
 *      rows across a 100k+-row country catalog, so this is a fast, cheap,
 *      no-LLM retrieval step, same division of labour as Agoda's local DB pull.
 *   2. A heuristic pre-sort/cap (rating + sold-count + official/preferred-shop
 *      trust signals) down to a bounded candidate pool BEFORE ever calling Kimi —
 *      dumping thousands of raw rows into an LLM prompt would be slow and
 *      wasteful, the same lesson learned building the hotel pipeline.
 *   3. Kimi picks/explains a small, diverse shortlist from that capped pool
 *      against the shopper's actual phrasing and any stated budget.
 *
 * No ACP mint / affiliate-link wrapping happens here at all — deliberately out
 * of scope for this pass (discovery/recommendation first, monetization once the
 * Shopee/iHerb affiliate mechanics are sorted — see project memory). Picks carry
 * the raw product_url as-is.
 */

import { chat, type ChatMessage } from "./broker.js";
import { searchProductCandidates, searchProductsByTitle, isProductsDbAvailable, type ProductRow } from "./product-db.js";

const STAGE_A_RANKING_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export interface ProductSearchParams {
  query: string; // free text, e.g. "toothbrush", "vitamin c serum"
  country: string; // ISO alpha-2 — selects which country's catalog to search
  merchants?: string[]; // restrict to these merchants (e.g. ["iherb"]) — omit to search all locally-catalogued merchants for this country
  budgetMax?: number; // optional max price filter (sale_price if present, else price)
  excludeProductIds?: string[]; // leave out — used when the shopper explicitly wants different options
}

export interface ProductPick {
  productId: string;
  merchant: string;
  title: string;
  price: number | null;
  salePrice: number | null;
  currency: string | null;
  rating: number | null;
  soldCount: number | null;
  isOfficial: boolean;
  category: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  reasoning: string;
}

export interface ProductSearchResult {
  query: string;
  country: string;
  candidateCount: number;
  picks: ProductPick[];
}

function effectivePrice(row: ProductRow): number | null {
  return row.sale_price ?? row.price ?? null;
}

function toPick(row: ProductRow, reasoning: string): ProductPick {
  return {
    productId: row.product_id,
    merchant: row.merchant,
    title: row.title ?? `${row.merchant} product #${row.product_id}`,
    price: row.price,
    salePrice: row.sale_price,
    currency: row.currency,
    rating: row.rating,
    soldCount: row.sold_count,
    isOfficial: row.is_official === 1,
    category: row.category,
    productUrl: row.product_url,
    imageUrl: row.image_url,
    reasoning,
  };
}

/** Heuristic trust/popularity score used to pre-sort BEFORE the LLM ever sees the
 *  pool — rating alone rewards a 5.0 with one review as much as a 5.0 with 10,000;
 *  weighting by log(sold_count) means genuine popularity actually counts, and an
 *  official/preferred shop gets a modest trust boost (same spirit as Agoda's
 *  star_rating-as-luxury-signal decision: prefer a real, checkable signal over
 *  free-form text). */
function heuristicScore(row: ProductRow): number {
  const rating = row.rating ?? 3.5; // unrated items shouldn't zero out entirely
  const sold = Math.log((row.sold_count ?? 0) + 2);
  const trust = (row.is_official === 1 ? 1.15 : 1) * (row.is_preferred === 1 ? 1.05 : 1);
  return rating * sold * trust;
}

export async function searchLocalProducts(params: ProductSearchParams): Promise<ProductSearchResult | null> {
  if (!isProductsDbAvailable()) {
    console.warn(`[product-search] local product DB unavailable — cannot run local search`);
    return null;
  }

  let rows = searchProductCandidates({
    query: params.query,
    country: params.country,
    merchants: params.merchants,
    inStockOnly: true,
    limit: 300,
  });

  if (rows.length === 0) {
    console.log(`[product-search] 0 candidates for "${params.query}" in ${params.country}`);
    return null;
  }

  if (params.excludeProductIds?.length) {
    const exclude = new Set(params.excludeProductIds);
    rows = rows.filter((r) => !exclude.has(r.product_id));
  }

  // Budget filter — same null-price leniency as Agoda's budget filter (don't drop a
  // product blind just because we don't have a price for it).
  if (params.budgetMax != null) {
    const budget = params.budgetMax;
    rows = rows.filter((r) => {
      const p = effectivePrice(r);
      return p === null || p <= budget;
    });
  }
  if (rows.length === 0) {
    console.log(`[product-search] budget filter (<=${params.budgetMax}) left 0 candidates`);
    return null;
  }

  const candidateCount = rows.length;
  const scored = [...rows].sort((a, b) => heuristicScore(b) - heuristicScore(a)).slice(0, 40);

  const candidates = scored.map((row) => ({
    product_id: row.product_id,
    merchant: row.merchant,
    title: row.title,
    category: row.category,
    brand: row.brand,
    price: row.price,
    sale_price: row.sale_price,
    currency: row.currency,
    rating: row.rating,
    sold_count: row.sold_count,
    is_official: row.is_official === 1,
  }));

  const rankingPrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a product-ranking engine for a shopping concierge bot. You'll get a JSON list of real ` +
        `product candidates from our own catalog (title, price, sale_price, rating, sold_count, ` +
        `is_official — a verified/official brand store) plus what the shopper actually asked for. Pick ` +
        `the 3-4 best, DIVERSE matches (don't return 4 near-identical variants of the same item unless ` +
        `that's genuinely all that's relevant) and explain each in one short, concrete sentence citing ` +
        `real facts from the candidate (price, rating, sold_count, official-store status) — never invent ` +
        `facts not in the list.\n\n` +
        `sale_price is the current price if present (price is the pre-discount reference price) — always ` +
        `reason about sale_price when both are given. Only choose from the given product_id values, never ` +
        `invent products.\n\n` +
        `Return ONLY valid JSON, no explanation:\n` +
        `{ "picks": [ { "product_id": string, "merchant": string, "reasoning": string } ] } — 3 to 4 picks, best first.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        shopper_query: params.query,
        budget_max: params.budgetMax ?? null,
        candidates,
      }),
    },
  ];

  let picks: ProductPick[] = [];
  try {
    const raw = await withTimeout(chat(rankingPrompt, true), STAGE_A_RANKING_TIMEOUT_MS, "product ranking");
    const parsed = JSON.parse(raw) as { picks?: Array<{ product_id: string; merchant: string; reasoning: string }> };
    const byKey = new Map(scored.map((row) => [`${row.merchant}:${row.product_id}`, row]));

    picks = (parsed.picks ?? [])
      .map((p): ProductPick | null => {
        const row = byKey.get(`${p.merchant}:${p.product_id}`);
        if (!row) return null;
        return toPick(row, p.reasoning);
      })
      .filter((p): p is ProductPick => p !== null)
      .slice(0, 4);
  } catch (err) {
    console.warn(`[product-search] Kimi ranking failed, falling back to top rows:`, err instanceof Error ? err.message : err);
  }

  if (picks.length === 0) {
    picks = scored.slice(0, 4).map((row) => toPick(row, "Top-rated, popular option matching your search."));
  }

  console.log(`[product-search] "${params.query}" (${params.country}): ${candidateCount} candidates -> ${picks.length} picks`);

  return { query: params.query, country: params.country, candidateCount, picks };
}

/** Direct title lookup — for when the shopper names a specific product that isn't (or
 *  is no longer) part of the currently active search results, mirroring Agoda's
 *  findHotelPickByName. */
export function findProductPickByName(params: {
  nameQuery: string;
  country: string;
  merchants?: string[];
}): ProductPick | null {
  if (!isProductsDbAvailable()) return null;
  const rows = searchProductsByTitle({ nameQuery: params.nameQuery, country: params.country, merchants: params.merchants, limit: 5 });
  if (rows.length === 0) {
    console.log(`[product-search] no DB match for "${params.nameQuery}" in ${params.country}`);
    return null;
  }
  const best = rows[0];
  console.log(`[product-search] resolved "${params.nameQuery}" -> ${best.title} (${best.merchant}:${best.product_id})`);
  return toPick(best, "You chose this one.");
}
