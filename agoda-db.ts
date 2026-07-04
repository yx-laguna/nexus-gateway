/**
 * agoda-db.ts
 *
 * Read-only query layer over the pre-built SQLite hotel database (see
 * scripts/build-agoda-db.mjs), which was generated offline from
 * Agoda_Hotels_EN.csv (1.25M rows). We only ever need it for enrichment —
 * address, geo, accommodation type, a short description snippet — keyed by
 * hotelId from a live Agoda API search response. All pricing/availability
 * comes from the live API, never from this file (it can go stale).
 *
 * The .sqlite file lives on a persistent Render disk (see render.yaml),
 * not in git — see NOTES-agoda-hosting.md for how it gets there.
 */

import Database from "better-sqlite3";

export interface HotelRow {
  hotel_id: number;
  hotel_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  countryisocode: string | null;
  star_rating: number | null;
  longitude: number | null;
  latitude: number | null;
  city_id: number | null;
  number_of_reviews: number | null;
  rating_average: number | null;
  rates_from: number | null;
  rates_currency: string | null;
  accommodation_type: string | null;
  overview: string | null;
}

const DB_PATH = process.env.AGODA_DB_PATH ?? "./agoda_hotels.sqlite";

let _db: Database.Database | null = null;
let _openFailed = false;

function getDb(): Database.Database {
  if (_db) return _db;
  if (_openFailed) throw new Error(`[agoda-db] previously failed to open ${DB_PATH}`);
  try {
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    _db.pragma("query_only = true");
    console.log(`[agoda-db] opened ${DB_PATH}`);
    return _db;
  } catch (err) {
    _openFailed = true;
    throw err;
  }
}

/** Best-effort availability check — lets callers degrade gracefully (Kimi ranking
 *  still works from live API data alone, just without address/geo enrichment). */
export function isAgodaDbAvailable(): boolean {
  try {
    getDb();
    return true;
  } catch (err) {
    console.warn(`[agoda-db] unavailable — enrichment will be skipped:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Look up enrichment rows for a batch of hotel IDs (from a live API search response). */
export function getHotelsByIds(hotelIds: number[]): Map<number, HotelRow> {
  const result = new Map<number, HotelRow>();
  if (hotelIds.length === 0) return result;

  const db = getDb();
  // SQLite's default bound-parameter limit is 999 — chunk defensively.
  const CHUNK = 500;
  for (let i = 0; i < hotelIds.length; i += CHUNK) {
    const chunk = hotelIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const stmt = db.prepare(`SELECT * FROM hotels WHERE hotel_id IN (${placeholders})`);
    const rows = stmt.all(...chunk) as HotelRow[];
    for (const row of rows) result.set(row.hotel_id, row);
  }
  return result;
}
