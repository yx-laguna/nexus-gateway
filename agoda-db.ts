/**
 * agoda-db.ts
 *
 * Read-only query layer over the pre-built SQLite hotel database (see
 * scripts/build-agoda-db.py), which was generated offline from
 * Agoda_Hotels_EN.csv (1.25M rows). Used by agoda-search.ts's Stage A
 * (local-first search) to build a candidate pool before ever touching
 * the live Agoda API.
 *
 * The .sqlite file lives on a persistent Render disk (see render.yaml),
 * not in git — see NOTES-agoda-hosting.md for how it gets there.
 *
 * Uses Node's built-in `node:sqlite` module (DatabaseSync) rather than the
 * `better-sqlite3` native addon. better-sqlite3 needs to compile a C++
 * binding against V8 at install time, and Render's Node 26.4.0 build image
 * removed several V8 APIs (Context::GetIsolate, PropertyCallbackInfo::This,
 * Object::GetPrototype) that better-sqlite3's bundled version still called —
 * the compile failed on every deploy, silently (the build script didn't
 * propagate the failure), so the app ran with no local DB at all. node:sqlite
 * ships inside Node itself (stable/RC since v25.7.0) — no compilation, no
 * bindings-file lookup, no ABI mismatch possible.
 */

import { DatabaseSync } from "node:sqlite";

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

let _db: DatabaseSync | null = null;
let _openFailed = false;

function getDb(): DatabaseSync {
  if (_db) return _db;
  if (_openFailed) throw new Error(`[agoda-db] previously failed to open ${DB_PATH}`);
  try {
    _db = new DatabaseSync(DB_PATH, { readOnly: true });
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

/**
 * Local-first hotel search — all hotels in a city, ordered by rating, no live API call.
 * Used by agoda-search.ts's Stage A (searchLocalHotels) to build a candidate pool that gets
 * distance/budget filtered and Kimi-ranked before ever touching the live Agoda API.
 */
export function searchHotelsByCityId(cityId: number, limit = 500): HotelRow[] {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT * FROM hotels WHERE city_id = ? ORDER BY rating_average DESC, number_of_reviews DESC LIMIT ?`
  );
  return stmt.all(cityId, limit) as unknown as HotelRow[];
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
    const rows = stmt.all(...chunk) as unknown as HotelRow[];
    for (const row of rows) result.set(row.hotel_id, row);
  }
  return result;
}
