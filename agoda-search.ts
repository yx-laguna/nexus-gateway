/**
 * agoda-search.ts
 *
 * Two-stage hotel search, so the live Agoda API is only ever called when the
 * user actually asks for real-time prices:
 *
 *   Stage A — searchLocalHotels() — ALWAYS runs (blended into the first reply)
 *     1. Resolve the destination to an Agoda city_id (agoda-city-lookup.ts).
 *     2. Pull a candidate pool straight from the local hotel DB (agoda-db.ts,
 *        built offline from Agoda_Hotels_EN.csv) — no live API call, free, fast.
 *     3. If the traveller gave a location preference ("near Thonglor"), ask
 *        Kimi to estimate that place's lat/lon from its own knowledge, then
 *        compute real haversine distance from every candidate hotel (the CSV
 *        has hotel lat/lon) and sort/filter by it.
 *     4. Filter by budget using the CSV's rates_from (a static estimate).
 *     5. Kimi ranks the top 3, citing distance/price/rating explicitly.
 *
 *   Stage B — fetchLiveAgodaPrices() — only runs when the user explicitly asks
 *     for real-time prices, or asks for the booking link (which needs live
 *     data to exist regardless). Calls the live Agoda hotel-list-search for
 *     exactly the Stage A picks and merges in real dailyRate/landingURL/etc.
 *
 * The winning pick's landingURL from Stage B IS the dedicated, hotel-specific,
 * dated booking link — cid=<AGODA_SITE_ID> is already baked in by Agoda.
 */

import { chat, type ChatMessage } from "./broker.js";
import { findCity, type CityMatch } from "./agoda-city-lookup.js";
import { searchHotelsByIds, type AgodaSearchResult } from "./agoda-api.js";
import { searchHotelsByCityId, isAgodaDbAvailable, type HotelRow } from "./agoda-db.js";

// ---------------------------------------------------------------------------
// Stage A's two Kimi calls (geocode estimate + ranking) both have solid,
// already-built fallbacks (skip geocoding / sort by rating). But broker.ts's
// client-level timeout is 50s — same order of magnitude as agent.ts's whole
// pipeline budget. If an earlier step (e.g. a slow/cold intent-extraction
// call) already ate most of that budget, a slow ranking call won't fail fast
// enough to fall back within the time the user is actually waiting — the
// outer pipeline gives up first and the graceful fallback never gets a
// chance to return. Give these two calls their own leash so a slow Kimi
// response degrades to real (unranked) DB results instead of the generic
// "took too long" message.
//
// NOTE: an earlier version set both to 8s. Real logs showed the ranking call
// (it ships ~40 candidates as JSON and asks for 3 picks + reasoning — a much
// bigger prompt than the geocode call) missed 8s on every single request,
// so ranking was effectively disabled and every reply fell back to the
// generic "Top-rated option in the area" text. Geocoding's own timeout can
// stay short (it reliably resolves or declines within a few seconds);
// ranking needs more room to actually produce tailored picks.
// ---------------------------------------------------------------------------

const STAGE_A_GEOCODE_TIMEOUT_MS = 10_000;
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalSearchParams {
  cityQuery: string;
  checkinDate: string; // YYYY-MM-DD
  checkoutDate: string; // YYYY-MM-DD
  adults?: number;
  children?: number;
  budgetMaxPerNight?: number;
  preferenceText?: string; // free text: "near Thonglor", "close to the beach", etc.
  countryHint?: string | null; // ISO alpha-2 — narrows city name collisions
}

export interface HotelPick {
  hotelId: number;
  hotelName: string;
  address: string | null;
  distanceKm: number | null; // real haversine distance to the geocoded preference, if any
  approxRatePerNight: number | null; // CSV rates_from — static estimate, not live
  currency: string | null;
  starRating: number | null;
  reviewScore: number | null; // CSV rating_average
  reasoning: string;
  // Populated by fetchLiveAgodaPrices() — absent until Stage B runs
  liveDailyRate?: number;
  liveCurrency?: string;
  liveDiscountPct?: number;
  liveIncludeBreakfast?: boolean;
  liveFreeWifi?: boolean;
  landingURL?: string;
}

export interface LocalSearchResult {
  resolvedCity: CityMatch;
  candidateCount: number;
  preferenceGeocoded: boolean;
  picks: HotelPick[];
}

// ---------------------------------------------------------------------------
// Haversine distance
// ---------------------------------------------------------------------------

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Kimi-estimated geocoding — no external geocoding API, just the model's own
// world knowledge. Less precise than a real geocoder, good enough for ranking.
// ---------------------------------------------------------------------------

interface Coords {
  lat: number;
  lon: number;
}

async function estimateCoordinates(placeName: string, cityName: string, country: string): Promise<Coords | null> {
  const prompt: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a geography lookup engine. Given a district/neighbourhood/landmark name inside a city, ` +
        `return your best estimate of its latitude and longitude from your own knowledge.\n\n` +
        `Return ONLY valid JSON: { "lat": number, "lon": number } if you have reasonable confidence in ` +
        `this specific place, or { "lat": null, "lon": null } if you don't recognise it. Do not guess wildly.`,
    },
    { role: "user", content: `Place: "${placeName}" in ${cityName}, ${country}` },
  ];

  try {
    const raw = await withTimeout(chat(prompt, true), STAGE_A_GEOCODE_TIMEOUT_MS, "geocode estimate");
    const parsed = JSON.parse(raw) as { lat: number | null; lon: number | null };
    if (typeof parsed.lat === "number" && typeof parsed.lon === "number") {
      return { lat: parsed.lat, lon: parsed.lon };
    }
    return null;
  } catch (err) {
    console.warn(`[agoda-search] coordinate estimate failed for "${placeName}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage A — local DB search, no live API call
// ---------------------------------------------------------------------------

export async function searchLocalHotels(params: LocalSearchParams): Promise<LocalSearchResult | null> {
  const cityMatches = findCity(params.cityQuery, params.countryHint);
  if (cityMatches.length === 0) {
    console.warn(`[agoda-search] no city match for "${params.cityQuery}"`);
    return null;
  }
  const resolvedCity = cityMatches[0];

  if (!isAgodaDbAvailable()) {
    console.warn(`[agoda-search] local hotel DB unavailable — cannot run local search`);
    return null;
  }

  let rows = searchHotelsByCityId(resolvedCity.city_id, 500);
  if (rows.length === 0) {
    console.log(`[agoda-search] 0 local rows for ${resolvedCity.city} (${resolvedCity.city_id})`);
    return null;
  }

  // Budget filter — keep hotels with an unknown rate rather than drop them blind.
  if (params.budgetMaxPerNight) {
    const budget = params.budgetMaxPerNight;
    rows = rows.filter((r) => r.rates_from === null || r.rates_from <= budget);
  }
  if (rows.length === 0) {
    console.log(`[agoda-search] budget filter (<=${params.budgetMaxPerNight}) left 0 candidates`);
    return null;
  }

  // Distance filter/sort — only if we can geocode the stated preference.
  let preferenceGeocoded = false;
  let scored: Array<{ row: HotelRow; distanceKm: number | null }>;

  if (params.preferenceText) {
    const coords = await estimateCoordinates(params.preferenceText, resolvedCity.city, resolvedCity.country);
    if (coords) {
      preferenceGeocoded = true;
      scored = rows
        .filter((r) => r.latitude !== null && r.longitude !== null)
        .map((row) => ({ row, distanceKm: haversineKm(coords.lat, coords.lon, row.latitude!, row.longitude!) }))
        .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))
        .slice(0, 40);
      console.log(
        `[agoda-search] geocoded "${params.preferenceText}" -> ${coords.lat},${coords.lon} — ${scored.length} hotels scored by distance`
      );
    } else {
      console.log(`[agoda-search] could not geocode "${params.preferenceText}" — ranking on text/rating only`);
      scored = rows.slice(0, 40).map((row) => ({ row, distanceKm: null }));
    }
  } else {
    scored = rows.slice(0, 40).map((row) => ({ row, distanceKm: null }));
  }

  const candidates = scored.map(({ row, distanceKm }) => ({
    hotel_id: row.hotel_id,
    name: row.hotel_name,
    address: row.address,
    distance_km: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
    approx_rate_per_night: row.rates_from,
    currency: row.rates_currency,
    star_rating: row.star_rating,
    rating_average: row.rating_average,
    number_of_reviews: row.number_of_reviews,
    accommodation_type: row.accommodation_type,
    description: row.overview,
  }));

  const rankingPrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a hotel-ranking engine for a travel concierge bot. You'll get a JSON list of real hotel ` +
        `candidates from our own hotel database (names, addresses, approximate rates, ratings, and — when ` +
        `the traveller gave a location preference — a computed distance_km to that location) plus the ` +
        `traveller's preferences. Pick the 3 best matches and explain each in one short, concrete sentence ` +
        `(cite the actual reason: distance_km if present, price, rating — don't be generic).\n\n` +
        `IMPORTANT: approx_rate_per_night is from static data and may be stale — treat it as a rough guide, ` +
        `not a live price, and don't state it as a confirmed price. If distance_km is present for a ` +
        `candidate, weigh it heavily against the traveller's stated location preference. Never invent ` +
        `hotels or facts not in the list — only choose from the given hotel_id values.\n\n` +
        `Return ONLY valid JSON, no explanation:\n` +
        `{ "picks": [ { "hotel_id": number, "reasoning": string } ] } — EXACTLY 3 picks, best first.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        destination: resolvedCity.city,
        checkin: params.checkinDate,
        checkout: params.checkoutDate,
        traveller_preferences: params.preferenceText || "no specific preference stated — optimise for overall value",
        budget_max_per_night: params.budgetMaxPerNight ?? null,
        candidates,
      }),
    },
  ];

  function toPick(row: HotelRow, distanceKm: number | null, reasoning: string): HotelPick {
    return {
      hotelId: row.hotel_id,
      hotelName: row.hotel_name ?? `Hotel #${row.hotel_id}`,
      address: row.address,
      distanceKm,
      approxRatePerNight: row.rates_from,
      currency: row.rates_currency,
      starRating: row.star_rating,
      reviewScore: row.rating_average,
      reasoning,
    };
  }

  let picks: HotelPick[] = [];
  try {
    const raw = await withTimeout(chat(rankingPrompt, true), STAGE_A_RANKING_TIMEOUT_MS, "hotel ranking");
    const parsed = JSON.parse(raw) as { picks?: Array<{ hotel_id: number; reasoning: string }> };
    const byId = new Map(scored.map(({ row, distanceKm }) => [row.hotel_id, { row, distanceKm }]));

    picks = (parsed.picks ?? [])
      .map((p): HotelPick | null => {
        const entry = byId.get(Number(p.hotel_id));
        if (!entry) return null;
        return toPick(entry.row, entry.distanceKm, p.reasoning);
      })
      .filter((p): p is HotelPick => p !== null)
      .slice(0, 3);
  } catch (err) {
    console.warn(`[agoda-search] Kimi ranking failed, falling back to top rows:`, err instanceof Error ? err.message : err);
  }

  if (picks.length === 0) {
    picks = scored
      .slice(0, 3)
      .map(({ row, distanceKm }) =>
        toPick(
          row,
          distanceKm,
          distanceKm !== null
            ? `Closest match to "${params.preferenceText}" among top-rated options.`
            : "Top-rated option in the area."
        )
      );
  }

  console.log(
    `[agoda-search] ${resolvedCity.city} (${resolvedCity.city_id}): ${rows.length} local candidates -> ${picks.length} picks (geocoded=${preferenceGeocoded})`
  );

  return { resolvedCity, candidateCount: rows.length, preferenceGeocoded, picks };
}

// ---------------------------------------------------------------------------
// Stage B — live Agoda pricing for the Stage A picks. Only call this when the
// user explicitly asks for real-time prices, or the booking link (which
// needs live data regardless).
// ---------------------------------------------------------------------------

export async function fetchLiveAgodaPrices(
  picks: HotelPick[],
  params: { checkinDate: string; checkoutDate: string; adults?: number; children?: number }
): Promise<HotelPick[]> {
  if (picks.length === 0) return picks;

  let live: AgodaSearchResult[];
  try {
    live = await searchHotelsByIds({
      hotelIds: picks.map((p) => p.hotelId),
      checkInDate: params.checkinDate,
      checkOutDate: params.checkoutDate,
      adults: params.adults ?? 2,
      children: params.children ?? 0,
    });
  } catch (err) {
    console.error(`[agoda-search] live price fetch failed:`, err instanceof Error ? err.message : err);
    return picks;
  }

  console.log(`[agoda-search] Stage B: fetched live prices for ${live.length}/${picks.length} picks`);

  const byId = new Map(live.map((r) => [r.hotelId, r]));
  return picks.map((pick) => {
    const l = byId.get(pick.hotelId);
    if (!l) return pick;
    return {
      ...pick,
      liveDailyRate: l.dailyRate,
      liveCurrency: l.currency,
      liveDiscountPct: l.discountPercentage,
      liveIncludeBreakfast: l.includeBreakfast,
      liveFreeWifi: l.freeWifi,
      landingURL: l.landingURL,
    };
  });
}
