/**
 * agoda-city-lookup.ts
 *
 * Resolves free-text destination mentions ("Bangkok", "New York", "KL") to
 * Agoda city IDs using the pre-built agoda_city_lookup.json (50,677 cities,
 * derived from Agoda_Hotels_EN.csv). Loaded once into memory — the file is
 * ~4.3MB, small enough to keep resident for the life of the process.
 */

import { readFileSync } from "fs";

export interface CityMatch {
  city: string;
  city_id: number;
  country: string;
  iso: string;
}

const LOOKUP_PATH = process.env.AGODA_CITY_LOOKUP_PATH ?? "./agoda_city_lookup.json";

let _lookup: Record<string, CityMatch[]> | null = null;

function loadLookup(): Record<string, CityMatch[]> {
  if (_lookup) return _lookup;
  try {
    const raw = readFileSync(LOOKUP_PATH, "utf8");
    _lookup = JSON.parse(raw) as Record<string, CityMatch[]>;
    console.log(`[agoda-city] loaded ${Object.keys(_lookup).length} city keys from ${LOOKUP_PATH}`);
  } catch (err) {
    console.error(
      `[agoda-city] failed to load city lookup at ${LOOKUP_PATH}:`,
      err instanceof Error ? err.message : err
    );
    _lookup = {};
  }
  return _lookup;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\s()]/g, "");
}

function filterByCountry(matches: CityMatch[], countryHint?: string | null): CityMatch[] {
  if (!countryHint) return matches;
  const iso = countryHint.toUpperCase();
  const filtered = matches.filter((m) => m.iso === iso);
  return filtered.length > 0 ? filtered : matches;
}

/**
 * Resolve a free-text city/destination mention to Agoda city IDs.
 * Tries an exact key match first (handles state-suffixed entries like
 * "new york (ny)"), then falls back to a bounded prefix/substring scan.
 * If countryHint (ISO alpha-2) is given and multiple cities share a name
 * across countries, results are narrowed to that country when possible.
 */
export function findCity(query: string, countryHint?: string | null): CityMatch[] {
  const lookup = loadLookup();
  const key = normalize(query);
  if (!key) return [];

  const exact = lookup[key];
  if (exact && exact.length > 0) return filterByCountry(exact, countryHint);

  // Bounded fallback scan — city names are short strings, this is cheap even
  // over 50k keys, but cap results so a very generic query doesn't blow up.
  const candidates: CityMatch[] = [];
  for (const [k, v] of Object.entries(lookup)) {
    if (k.startsWith(key) || k.includes(key)) {
      candidates.push(...v);
      if (candidates.length >= 20) break;
    }
  }
  return filterByCountry(candidates, countryHint);
}
