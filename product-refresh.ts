/**
 * product-refresh.ts
 *
 * Keeps products.sqlite (see product-db.ts / scripts/build-products-db.py) fresh
 * automatically — no manual file transfer to the Render disk, ever (unlike the
 * one-time manual scp documented in NOTES-agoda-hosting.md for agoda_hotels.sqlite).
 *
 * Why this exists: Render cron jobs cannot attach persistent disks, and a disk
 * cannot be shared across two services — so a separate "daily rebuild" service
 * hitting the same disk isn't possible. Instead this runs *inside* the existing
 * nexus-gateway web service process, which already has the disk mounted:
 *
 *   1. On startup, if PRODUCTS_DB_PATH doesn't exist yet (fresh disk / first
 *      deploy) or its last refresh is >24h old, kick off a rebuild immediately.
 *   2. Reschedule the next rebuild ~24h after each run, indefinitely, for as
 *      long as the process stays alive (the render.yaml keepalive cron pings
 *      /health every 5min specifically so this process doesn't spin down).
 *   3. A rebuild streams each configured feed URL directly off the network
 *      (fetch -> NUL-strip -> csv-parse) straight into a temp SQLite file next
 *      to the live one — never buffering a whole feed (up to ~225MB raw) in
 *      memory or writing a scratch CSV to disk.
 *   4. Once the temp file has at least one row, fs.renameSync it over the live
 *      path (atomic, same filesystem) and tell product-db.ts to reopen — in-
 *      flight readers keep serving the old (already-detached-from-the-path)
 *      file handle until that reopen call swaps them onto the new one, so
 *      there's no window where queries see a half-built catalog.
 *
 * Feed sources are read from env vars, not hardcoded — see .env.example /
 * render.yaml. Only whichever COUNTRY vars are actually set get ingested, so
 * adding a country later (Shopee PH/TH/TW, more iHerb countries, eventually
 * Lazada) is purely a Render dashboard change, not a code change.
 */

import { DatabaseSync } from "node:sqlite";
import { parse } from "csv-parse";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { existsSync, renameSync, unlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { reopenProductsDb } from "./product-db.js";

const DB_PATH = process.env.PRODUCTS_DB_PATH ?? "./products.sqlite";
const META_PATH = `${DB_PATH}.meta.json`;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Feed source config — env-var driven, same shape for every merchant/country
// ---------------------------------------------------------------------------

interface FeedSource {
  merchant: "shopee" | "iherb";
  country: string; // ISO alpha-2
  url: string;
}

const SHOPEE_COUNTRIES = ["SG", "MY", "PH", "TH", "TW", "ID"] as const;
const IHERB_COUNTRIES = ["SG", "MY", "PH"] as const;

const SHOPEE_CURRENCY: Record<string, string> = { SG: "SGD", MY: "MYR", PH: "PHP", TH: "THB", TW: "TWD", ID: "IDR" };
const IHERB_CURRENCY: Record<string, string> = { SG: "SGD", MY: "MYR", PH: "PHP" };

function getConfiguredFeedSources(): FeedSource[] {
  const sources: FeedSource[] = [];
  for (const country of SHOPEE_COUNTRIES) {
    const url = process.env[`SHOPEE_FEED_URL_${country}`];
    if (url) sources.push({ merchant: "shopee", country, url });
  }
  for (const country of IHERB_COUNTRIES) {
    const url = process.env[`IHERB_FEED_URL_${country}`];
    if (url) sources.push({ merchant: "iherb", country, url });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Small helpers — direct ports of scripts/build-products-db.py's semantics
// ---------------------------------------------------------------------------

const DESCRIPTION_MAX_CHARS = 500;

function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v: unknown): number | null {
  const f = toFloat(v);
  return f !== null ? Math.trunc(f) : null;
}

/** Shopee's is_official_shop/is_preferred_shop are strings like "Official shop" /
 *  "Non-Preferred seller" / "Yes" / "No" — truthy iff it doesn't start with "Non-"
 *  and isn't "No". */
function toBoolInt(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().toLowerCase();
  if (s === "" || s === "no" || s === "none") return 0;
  if (s.startsWith("non-")) return 0;
  return 1;
}

function truncate(s: string | null | undefined, n = DESCRIPTION_MAX_CHARS): string | null {
  if (!s) return s ?? null;
  return s.slice(0, n);
}

/** https://iherb.prf.hn/click/camref:.../creativeref:.../destination:<url-encoded>
 *  -> the raw https://sg.iherb.com/pr/... URL, unencoded. We unwrap at ingest time
 *  because we mint our own wallet-attributed tracking link fresh at booking time
 *  (see ACPLagunaTranslator's mint-affiliate-link.ts), not reuse Involve Asia's
 *  baked-in camref/creativeref. */
function unwrapIherbUrl(wrapped: string | null | undefined): string | null {
  if (!wrapped) return null;
  const marker = "/destination:";
  const idx = wrapped.indexOf(marker);
  if (idx === -1) return wrapped; // already raw, or an unexpected format — pass through
  const raw = wrapped.slice(idx + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function iherbInStock(inventoryField: string | null | undefined): number | null {
  if (!inventoryField) return null;
  return inventoryField.includes(">0") ? 1 : 0;
}

/** Same fix as build-agoda-db.py / build-products-db.py needed for wild affiliate
 *  feed exports that contain embedded NUL bytes (breaks csv-parse the same way it
 *  broke Python's csv module). Strips them out of the byte stream before parsing. */
class StripNulTransform extends Transform {
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.includes(0)) {
      cb(null, Buffer.from(buf.filter((b) => b !== 0)));
    } else {
      cb(null, buf);
    }
  }
}

/** A failed download/parse can leave SQLite having already auto-closed the transaction
 *  on its own (a bad partial write mid-BEGIN can do this) — calling ROLLBACK on top of
 *  that throws "cannot rollback - no transaction is active" and, since this runs inside
 *  an existing catch block, that new error replaces and hides whatever the *real*
 *  failure was. Swallow rollback-specific failures so the original error is what
 *  actually surfaces in the logs. */
function safeRollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch (err) {
    console.warn(`[product-refresh] rollback no-op (transaction likely already closed by the original error):`, err instanceof Error ? err.message : err);
  }
}

async function fetchToNodeStream(url: string): Promise<Readable> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  }
  return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
}

// ---------------------------------------------------------------------------
// Schema (mirrors scripts/build-products-db.py exactly)
// ---------------------------------------------------------------------------

function createSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=OFF");
  db.exec("PRAGMA synchronous=OFF");
  db.exec("PRAGMA temp_store=MEMORY");
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant TEXT NOT NULL,
      country TEXT NOT NULL,
      product_id TEXT NOT NULL,
      shop_id TEXT,
      title TEXT,
      description TEXT,
      category TEXT,
      brand TEXT,
      price REAL,
      sale_price REAL,
      currency TEXT,
      rating REAL,
      sold_count INTEGER,
      stock INTEGER,
      is_official INTEGER,
      is_preferred INTEGER,
      image_url TEXT,
      product_url TEXT,
      last_updated INTEGER,
      UNIQUE(merchant, country, product_id)
    )
  `);
}

function finalizeSchema(db: DatabaseSync): void {
  db.exec("CREATE INDEX idx_products_merchant_country ON products(merchant, country)");
  db.exec("CREATE INDEX idx_products_country_price ON products(country, price)");
  db.exec(`
    CREATE VIRTUAL TABLE products_fts USING fts5(
      title, description, category, brand,
      content='products', content_rowid='id'
    )
  `);
  db.exec(`
    INSERT INTO products_fts(rowid, title, description, category, brand)
    SELECT id, title, description, category, brand FROM products
  `);
  // No VACUUM here (unlike the manual dev script) — this is a brand-new file
  // built fresh every run, so there's no bloat to reclaim, and VACUUM would
  // just add minutes + transient disk headroom for no benefit.
  db.exec("ANALYZE");
}

// ---------------------------------------------------------------------------
// Per-merchant ingestion — streamed straight from the network response
// ---------------------------------------------------------------------------

async function ingestShopee(db: DatabaseSync, country: string, url: string): Promise<number> {
  console.log(`[product-refresh] shopee:${country} downloading ${url.split("?")[0]}...`);
  const t0 = Date.now();
  const currency = SHOPEE_CURRENCY[country] ?? "USD";

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO products
    (merchant, country, product_id, shop_id, title, description, category, brand,
     price, sale_price, currency, rating, sold_count, stock, is_official, is_preferred,
     image_url, product_url, last_updated)
    VALUES ('shopee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `);

  let n = 0;
  db.exec("BEGIN");
  try {
    // stream.pipeline() (not manual .pipe().pipe()) is what actually matters here — a
    // manual pipe chain does NOT forward 'error' events between streams, so a network
    // hiccup partway through a ~200MB+ download (confirmed live: an ERR_HTTP2_STREAM_ERROR
    // mid-download) surfaced as an unhandled 'error' event and crashed the entire bot
    // process, not just this one feed. pipeline() attaches proper error handling and
    // cleanup to every stage, so the same failure now just rejects this promise, gets
    // caught below, and this one source is skipped while everything else proceeds.
    const nodeStream = await fetchToNodeStream(url);
    await pipeline(
      nodeStream,
      new StripNulTransform(),
      parse({ columns: true, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }),
      async function insertRows(source) {
        for await (const row of source as AsyncIterable<Record<string, string>>) {
          const itemid = row.itemid;
          if (!itemid) continue;
          const productUrl = (row.product_link ?? "").trim() || null;
          stmt.run(
            country,
            itemid,
            row.shopid ?? null,
            row.title ?? null,
            truncate(row.description),
            row.global_category1 ?? null,
            row.global_brand || null,
            toFloat(row.price),
            toFloat(row.sale_price),
            currency,
            toFloat(row.item_rating),
            toInt(row.item_sold),
            toInt(row.stock),
            toBoolInt(row.is_official_shop),
            toBoolInt(row.is_preferred_shop),
            row.image_link ?? null,
            productUrl
          );
          n++;
        }
      }
    );
    db.exec("COMMIT");
  } catch (err) {
    safeRollback(db);
    throw err;
  }
  console.log(`[product-refresh] shopee:${country} inserted ${n.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return n;
}

async function ingestIherb(db: DatabaseSync, country: string, url: string): Promise<number> {
  console.log(`[product-refresh] iherb:${country} downloading ${url.split("?")[0]}...`);
  const t0 = Date.now();
  const currency = IHERB_CURRENCY[country] ?? "USD";

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO products
    (merchant, country, product_id, shop_id, title, description, category, brand,
     price, sale_price, currency, rating, sold_count, stock, is_official, is_preferred,
     image_url, product_url, last_updated)
    VALUES ('iherb', ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, strftime('%s','now'))
  `);

  let n = 0;
  db.exec("BEGIN");
  try {
    const nodeStream = await fetchToNodeStream(url);
    await pipeline(
      nodeStream,
      new StripNulTransform(),
      parse({ columns: true, bom: true, delimiter: "|", relax_column_count: true, relax_quotes: true, skip_empty_lines: true }),
      async function insertRows(source) {
        for await (const row of source as AsyncIterable<Record<string, string>>) {
          const productId = row.productID;
          if (!productId) continue;
          const productUrl = unwrapIherbUrl(row.url);
          stmt.run(
            country,
            productId,
            row.title ?? null,
            truncate(row.description),
            row.category ?? null,
            toFloat(row.price),
            currency,
            iherbInStock(row.inventory),
            row.image ?? null,
            productUrl
          );
          n++;
        }
      }
    );
    db.exec("COMMIT");
  } catch (err) {
    safeRollback(db);
    throw err;
  }
  console.log(`[product-refresh] iherb:${country} inserted ${n.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return n;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Deletes any leftover `.products.sqlite.tmp-<pid>` files sitting next to
 * PRODUCTS_DB_PATH. Real incident (2026-07-05): before the stream.pipeline()
 * fix, a hard process crash mid-refresh (an unhandled stream error) bypassed
 * refreshProductsDb()'s own try/finally cleanup entirely — Node died before
 * that finally block could run — leaving that run's temp file (potentially
 * several GB, unvacuumed) permanently orphaned on the persistent disk with
 * nothing left to ever reference or delete it. Each crash+restart added
 * another one, which is what showed up as disk usage climbing continuously
 * on the Render dashboard. Every past PID's temp file is stale by definition
 * (a PID is never reused across restarts), so anything matching the temp
 * naming pattern found here is always safe to delete on process startup.
 */
function cleanupStaleTempFiles(): void {
  const dir = dirname(DB_PATH) || ".";
  const prefix = `.${basename(DB_PATH)}.tmp-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.warn(`[product-refresh] could not scan ${dir} for stale temp files:`, err instanceof Error ? err.message : err);
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dir, name);
    try {
      unlinkSync(full);
      console.log(`[product-refresh] removed stale temp file from a previous crashed run: ${full}`);
    } catch (err) {
      console.warn(`[product-refresh] could not remove stale temp file ${full}:`, err instanceof Error ? err.message : err);
    }
  }
}

interface RefreshMeta {
  lastRefreshedAt: number; // epoch ms
  totalRows: number;
  sources: Record<string, number>; // "shopee:SG" -> row count
  failedSources?: string[];
}

function readMeta(): RefreshMeta | null {
  try {
    return JSON.parse(readFileSync(META_PATH, "utf8")) as RefreshMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: RefreshMeta): void {
  try {
    writeFileSync(META_PATH, JSON.stringify(meta, null, 2), "utf8");
  } catch (err) {
    console.warn(`[product-refresh] could not write ${META_PATH}:`, err instanceof Error ? err.message : err);
  }
}

async function buildFreshDb(tmpPath: string, sources: FeedSource[]): Promise<RefreshMeta> {
  if (existsSync(tmpPath)) unlinkSync(tmpPath);
  const db = new DatabaseSync(tmpPath);
  const perSource: Record<string, number> = {};
  const failed: string[] = [];

  try {
    createSchema(db);

    for (const src of sources) {
      const key = `${src.merchant}:${src.country}`;
      try {
        const n = src.merchant === "shopee"
          ? await ingestShopee(db, src.country, src.url)
          : await ingestIherb(db, src.country, src.url);
        perSource[key] = n;
      } catch (err) {
        console.error(`[product-refresh] ${key} failed, skipping:`, err instanceof Error ? err.message : err);
        failed.push(key);
      }
    }

    const totalRows = Object.values(perSource).reduce((a, b) => a + b, 0);
    if (totalRows > 0) {
      finalizeSchema(db);
    }
    return { lastRefreshedAt: Date.now(), totalRows, sources: perSource, failedSources: failed.length ? failed : undefined };
  } finally {
    db.close();
  }
}

let refreshInProgress = false;

/** Downloads every configured feed, builds a fresh SQLite file next to the live
 *  one, and atomically swaps it in — never leaves the live file mid-write for
 *  a query to observe. Safe to call repeatedly; overlapping calls are ignored. */
export async function refreshProductsDb(): Promise<void> {
  if (refreshInProgress) {
    console.log("[product-refresh] refresh already in progress, skipping");
    return;
  }
  const sources = getConfiguredFeedSources();
  if (sources.length === 0) {
    console.log("[product-refresh] no SHOPEE_FEED_URL_*/IHERB_FEED_URL_* env vars set — nothing to refresh");
    return;
  }

  refreshInProgress = true;
  const tmpPath = join(dirname(DB_PATH) || ".", `.products.sqlite.tmp-${process.pid}`);
  console.log(`[product-refresh] starting refresh — ${sources.length} feed(s) configured`);
  const t0 = Date.now();

  try {
    const meta = await buildFreshDb(tmpPath, sources);
    if (meta.totalRows === 0) {
      console.error("[product-refresh] zero rows ingested across all sources — aborting swap, keeping existing catalog");
      return;
    }

    renameSync(tmpPath, DB_PATH); // atomic — same directory/filesystem
    reopenProductsDb();
    writeMeta(meta);

    console.log(
      `[product-refresh] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${meta.totalRows.toLocaleString()} total rows` +
      (meta.failedSources ? ` (failed: ${meta.failedSources.join(", ")})` : "")
    );
  } catch (err) {
    console.error("[product-refresh] refresh failed, keeping existing catalog:", err instanceof Error ? err.message : err);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    refreshInProgress = false;
  }
}

/**
 * Call once at process startup. Bootstraps automatically on a brand-new disk
 * (no products.sqlite yet — e.g. first deploy after adding this feature, or a
 * fresh Render disk) and otherwise reschedules to land ~24h after the last
 * successful refresh, forever, for as long as this process stays alive.
 *
 * This is deliberately NOT a Render cron job — cron jobs on Render can't
 * attach persistent disks, and disks can't be shared across services, so a
 * separate scheduled service can't reach this same file. Running it inside
 * the always-on web service (kept warm by the existing keepalive cron in
 * render.yaml) is the only design that reaches PRODUCTS_DB_PATH at all.
 */
export function scheduleDailyProductRefresh(): void {
  // Runs once per process boot — exactly when any orphaned temp file from a
  // previous crash would otherwise sit unnoticed. See cleanupStaleTempFiles().
  cleanupStaleTempFiles();

  const sources = getConfiguredFeedSources();
  if (sources.length === 0) {
    console.log("[product-refresh] no feed URLs configured — auto-refresh disabled (set SHOPEE_FEED_URL_*/IHERB_FEED_URL_* to enable)");
    return;
  }

  const dbMissing = !existsSync(DB_PATH);
  const meta = readMeta();
  const elapsed = meta ? Date.now() - meta.lastRefreshedAt : Infinity;

  // Adding a new SHOPEE_FEED_URL_*/IHERB_FEED_URL_* env var always restarts this
  // process (Render restarts on env var changes), but the existing catalog is
  // still fresh — without this check, a newly-added country would silently wait
  // up to 24h before its first ingest instead of showing up on the very next
  // deploy, which isn't what "just add the env var" should feel like.
  const configuredKeys = new Set(sources.map((s) => `${s.merchant}:${s.country}`));
  const knownKeys = new Set(Object.keys(meta?.sources ?? {}));
  const newSourceKeys = [...configuredKeys].filter((k) => !knownKeys.has(k));

  const dueNow = dbMissing || !meta || elapsed >= ONE_DAY_MS || newSourceKeys.length > 0;
  const initialDelay = dueNow ? 0 : ONE_DAY_MS - elapsed;

  console.log(
    dbMissing
      ? "[product-refresh] no catalog on disk yet — bootstrapping now (first boot on this disk)"
      : newSourceKeys.length > 0
        ? `[product-refresh] new feed source(s) configured since last refresh (${newSourceKeys.join(", ")}) — refreshing now`
        : dueNow
          ? "[product-refresh] catalog is stale — refreshing now"
          : `[product-refresh] catalog is fresh — next refresh in ${(initialDelay / 3_600_000).toFixed(1)}h`
  );

  const run = () => {
    refreshProductsDb()
      .catch((err) => console.error("[product-refresh] unexpected error:", err))
      .finally(() => {
        setTimeout(run, ONE_DAY_MS).unref();
      });
  };

  setTimeout(run, initialDelay).unref();
}
