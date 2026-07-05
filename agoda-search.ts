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
import { searchHotelsByCityId, searchHotelsByNameInCity, isAgodaDbAvailable, type HotelRow } from "./agoda-db.js";

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
  // A stated MINIMUM per-night price — the mirror of budgetMaxPerNight. Enforced as a
  // real floor against both the static rate and the live price, same treatment as the max.
  budgetMinPerNight?: number;
  // "More luxurious", "something nicer", "5-star only" — with or without a specific
  // number. When set, star_rating becomes the PRIMARY candidate-selection/sort signal
  // instead of a hotel's own descriptive text or free-form LLM judgment (see the
  // star-rating sort below) — a 2-star budget hotel can otherwise still read as "nice"
  // in prose and get picked by distance-only ranking.
  wantsLuxury?: boolean;
  preferenceText?: string; // free text: "near Thonglor", "close to the beach", etc.
  countryHint?: string | null; // ISO alpha-2 — narrows city name collisions
  // Hotel IDs to leave out of the candidate pool entirely — used when the traveller
  // explicitly asks for different/other options than what was already shown, so a
  // re-search can't just land on the same picks again.
  excludeHotelIds?: number[];
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
// Airside transit lounges / day-use facilities (e.g. "Ambassador Transit
// Lounge - T3, Singapore Changi Airport (AIRSIDE)", "Changi Transit Hotel
// Terminal 1") are tagged accommodation_type: "Hotel" in the CSV and read
// like normal hotels, but they're not standard overnight-bookable stays —
// confirmed by calling Agoda's live hotelId search directly for a few of
// these: it returns nothing for them (no error, just absent from results),
// while a real airport hotel a few km away returns a normal live rate. They'd
// always show "price on request" and can never get a real booking link, so
// keep them out of the candidate pool entirely rather than recommend a dead
// end.
// ---------------------------------------------------------------------------

const NON_BOOKABLE_RE = /\btransit\s+lounge\b|\bairside\b|\btransit\s+hotel\b/i;

function isLikelyNonBookable(row: HotelRow): boolean {
  return NON_BOOKABLE_RE.test(row.hotel_name ?? "") || NON_BOOKABLE_RE.test(row.overview ?? "");
}

// ---------------------------------------------------------------------------
// Hotel-only filter — per explicit request, recommendations should be actual hotels,
// not serviced apartments, B&Bs, guesthouses, hostels, villas, etc. Their static rates
// and live-price availability have both proven far less reliable than standard hotels
// (see the budget/live-pricing fixes above), on top of just not matching what the
// traveller usually means by "hotel". The CSV's accommodation_type is a comma-separated
// list of tags (e.g. "Hotel, Resort", "Serviced apartment, Serviced apartment") — require
// "Hotel" to be one of the tags, which keeps legitimate combos like "Hotel, Resort" while
// dropping anything that's purely Apartment/Flat, Guesthouse/B&B, Serviced apartment,
// Hostel, Villa, Homestay, etc.
// ---------------------------------------------------------------------------

function isHotelType(row: HotelRow): boolean {
  const type = row.accommodation_type ?? "";
  return type
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .includes("hotel");
}

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

  const beforeFilter = rows.length;
  rows = rows.filter((r) => !isLikelyNonBookable(r));
  if (rows.length < beforeFilter) {
    console.log(`[agoda-search] filtered out ${beforeFilter - rows.length} transit-lounge/airside listing(s)`);
  }
  if (rows.length === 0) {
    console.log(`[agoda-search] 0 local rows left for ${resolvedCity.city} (${resolvedCity.city_id}) after transit-lounge filter`);
    return null;
  }

  const beforeTypeFilter = rows.length;
  rows = rows.filter((r) => isHotelType(r));
  if (rows.length < beforeTypeFilter) {
    console.log(`[agoda-search] filtered out ${beforeTypeFilter - rows.length} non-hotel (apartment/B&B/hostel/etc.) listing(s)`);
  }
  if (rows.length === 0) {
    console.log(`[agoda-search] 0 local rows left for ${resolvedCity.city} (${resolvedCity.city_id}) after hotel-type filter`);
    return null;
  }

  if (params.excludeHotelIds?.length) {
    const exclude = new Set(params.excludeHotelIds);
    rows = rows.filter((r) => !exclude.has(r.hotel_id));
  }
  if (rows.length === 0) {
    console.log(`[agoda-search] 0 local rows left for ${resolvedCity.city} (${resolvedCity.city_id}) after excluding previously-shown hotels`);
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

  // Minimum-price filter — the mirror of the max-budget filter above. Same null-rate
  // leniency (don't drop a hotel blind just because its static rate is unknown).
  if (params.budgetMinPerNight) {
    const minBudget = params.budgetMinPerNight;
    rows = rows.filter((r) => r.rates_from === null || r.rates_from >= minBudget);
  }
  if (rows.length === 0) {
    console.log(`[agoda-search] minimum-price filter (>=${params.budgetMinPerNight}) left 0 candidates`);
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
        .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
      console.log(
        `[agoda-search] geocoded "${params.preferenceText}" -> ${coords.lat},${coords.lon} — ${scored.length} hotels scored by distance`
      );
    } else {
      console.log(`[agoda-search] could not geocode "${params.preferenceText}" — ranking on text/rating only`);
      scored = rows.map((row) => ({ row, distanceKm: null }));
    }
  } else {
    scored = rows.map((row) => ({ row, distanceKm: null }));
  }

  // Luxury signal — real bug: a traveller asked for "more luxurious, above $200" and
  // still got a 2-star $33/night hotel back, because the backfill/swap logic (further
  // below) just grabs the next-closest untried candidate with zero star_rating
  // awareness. star_rating is a far more reliable "luxury" signal than trusting a
  // hotel's own descriptive text or Kimi's free-form judgment of it, so when the
  // traveller explicitly wants premium options (wantsLuxury, or gave a minimum price
  // floor as an implicit signal of the same), make star_rating the PRIMARY sort key —
  // applied as a stable sort AFTER the distance sort above, so distance still breaks
  // ties among equally-starred hotels, but star_rating now dominates the order that both
  // Kimi's initial ranking pool AND every backfill swap draw from.
  if (params.wantsLuxury || params.budgetMinPerNight != null) {
    scored = [...scored].sort((a, b) => (b.row.star_rating ?? 0) - (a.row.star_rating ?? 0));
  }

  // When a budget is specified, a hotel with a known static rate (already confirmed <=
  // budget above) is a meaningfully stronger bet to also have a real live rate than one
  // with rates_from: null. Real logs showed a budget search return 0 live prices across
  // every one of 6 candidates tried — the null-rate leniency policy (kept above so we
  // don't drop a hotel blind) means a budget-constrained pool skews heavily toward
  // unlisted-price properties, which correlate with "no live rate either". Stable-sort so
  // known-rate candidates are tried first, without disturbing the distance/rating order
  // otherwise.
  if (params.budgetMaxPerNight != null) {
    scored = [...scored].sort((a, b) => (a.row.rates_from !== null ? 0 : 1) - (b.row.rates_from !== null ? 0 : 1));
  }
  scored = scored.slice(0, 40);

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
        (params.wantsLuxury || params.budgetMinPerNight != null
          ? `LUXURY REQUEST: the traveller explicitly wants more expensive/premium options` +
            (params.budgetMinPerNight != null ? ` (minimum ${params.budgetMinPerNight}/night)` : "") +
            `. star_rating is the ONLY reliable signal for this — a hotel's name or description text is ` +
            `NOT evidence of luxury. Strongly prefer the highest star_rating candidates (5-star, then ` +
            `4.5-star) and do not pick anything below 4 stars unless nothing higher exists in the list. ` +
            `Never call a hotel "luxurious" in your reasoning unless its star_rating actually supports it.\n\n`
          : "") +
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
        budget_min_per_night: params.budgetMinPerNight ?? null,
        wants_luxury: params.wantsLuxury ?? false,
        candidates,
      }),
    },
  ];

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
          params.wantsLuxury || params.budgetMinPerNight != null
            ? `Top-rated ${row.star_rating ?? "high"}-star option in the area.`
            : distanceKm !== null
              ? `Closest match to "${params.preferenceText}" among top-rated options.`
              : "Top-rated option in the area."
        )
      );
  }

  console.log(
    `[agoda-search] ${resolvedCity.city} (${resolvedCity.city_id}): ${rows.length} local candidates -> ${picks.length} picks (geocoded=${preferenceGeocoded})`
  );

  // Live prices now come back fast enough (Kimi's thinking-mode fix cut ranking from
  // 40s+ to ~2-3s) to fetch upfront in the very first reply, not gate behind an
  // explicit "check real prices" request. This also doubles as quality control — a pick
  // gets swapped for the next-best untried candidate (bounded so we never check more
  // than a handful of hotels total) when either:
  //   - it has no live rate at all (same signature as the airside transit lounges from
  //     the previous fix — some other non-standard listing Agoda's live search has
  //     nothing for), or
  //   - its LIVE rate breaks the traveller's stated budget. The earlier static-data
  //     budget filter (above, using the CSV's rates_from) only catches a hotel whose
  //     stale estimate was already over budget — a hotel with rates_from: null or a
  //     misleadingly low static estimate sails through that filter and only reveals
  //     the real, over-budget price once Stage B runs. Re-checking against the live
  //     price here closes that gap.
  const budget = params.budgetMaxPerNight;
  const budgetMin = params.budgetMinPerNight;
  const overBudget = (p: HotelPick) => budget != null && p.liveDailyRate !== undefined && p.liveDailyRate > budget;
  const underBudget = (p: HotelPick) => budgetMin != null && p.liveDailyRate !== undefined && p.liveDailyRate < budgetMin;
  const isDead = (p: HotelPick) => p.liveDailyRate === undefined || overBudget(p) || underBudget(p);

  const MAX_LIVE_CHECK_ATTEMPTS = 8;
  const tried = new Set(picks.map((p) => p.hotelId));
  let attempts = picks.length;

  for (let round = 0; round < 4; round++) {
    picks = await fetchLiveAgodaPrices(picks, {
      checkinDate: params.checkinDate,
      checkoutDate: params.checkoutDate,
      adults: params.adults,
      children: params.children,
    });

    // Replace EVERY dead slot this round (not just the first) so a batch with multiple
    // no-price picks doesn't take multiple full rounds to clear out.
    const deadIndices = picks.map((p, i) => (isDead(p) ? i : -1)).filter((i) => i !== -1);
    if (deadIndices.length === 0 || attempts >= MAX_LIVE_CHECK_ATTEMPTS) break;

    let swappedAny = false;
    for (const idx of deadIndices) {
      if (attempts >= MAX_LIVE_CHECK_ATTEMPTS) break;
      const alt = scored.find(({ row }) => !tried.has(row.hotel_id));
      if (!alt) break; // no more untried candidates left
      tried.add(alt.row.hotel_id);
      attempts++;
      swappedAny = true;
      picks[idx] = toPick(
        alt.row,
        alt.distanceKm,
        params.wantsLuxury || params.budgetMinPerNight != null
          ? `Top-rated ${alt.row.star_rating ?? "high"}-star option with live availability.`
          : alt.distanceKm !== null
            ? `Closest match to "${params.preferenceText}" among top-rated options with live availability.`
            : "Top-rated option in the area with live availability."
      );
    }
    if (!swappedAny) break; // exhausted the whole candidate pool
  }

  // Never show an option we couldn't get a live price for at all — per explicit request,
  // drop it rather than displaying a priceless placeholder. An over-budget pick (a real
  // price that's just too high, with no cheaper alternative found nearby) is kept with an
  // explanatory note — that's different from "no price found" and still useful information.
  picks = picks.filter((p) => p.liveDailyRate !== undefined);

  if (budget != null) {
    picks = picks.map((p) =>
      overBudget(p)
        ? { ...p, reasoning: `${p.reasoning} (note: ${p.liveCurrency ?? p.currency ?? "USD"} ${p.liveDailyRate} is above your ${budget}/night budget — no cheaper option was available nearby.)` }
        : p
    );
  }
  if (budgetMin != null) {
    picks = picks.map((p) =>
      underBudget(p)
        ? { ...p, reasoning: `${p.reasoning} (note: ${p.liveCurrency ?? p.currency ?? "USD"} ${p.liveDailyRate} is below your ${budgetMin}/night minimum — no pricier option was available nearby.)` }
        : p
    );
  }

  return { resolvedCity, candidateCount: rows.length, preferenceGeocoded, picks };
}

// ---------------------------------------------------------------------------
// Live Agoda pricing for a set of picks. searchLocalHotels() above already calls
// this itself so every reply has live prices from the start — this export stays
// public for the rare case a caller wants to explicitly re-check/refresh prices
// for a search that's being reused as-is (see agent.ts's stored-search reuse).
// ---------------------------------------------------------------------------

export async function fetchLiveAgodaPrices(
  picks: HotelPick[],
  params: { checkinDate: string; checkoutDate: string; adults?: number; children?: number }
): Promise<HotelPick[]> {
  if (picks.length === 0) return picks;

  // Individual per-hotel calls (in parallel), not one batched multi-ID request. Real
  // logs showed a batched 3-hotel-ID call return 0/3 live prices twice in a row, then an
  // individual single-ID call for one of those SAME hotels succeed moments later — strong
  // evidence the batched form is the unreliable one, not genuine unavailability. Each
  // hotel also gets one retry after a short delay, since a single empty result can still
  // be a transient blip on Agoda's side.
  const results = await Promise.all(
    picks.map(async (pick): Promise<AgodaSearchResult | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const live = await searchHotelsByIds({
            hotelIds: [pick.hotelId],
            checkInDate: params.checkinDate,
            checkOutDate: params.checkoutDate,
            adults: params.adults ?? 2,
            children: params.children ?? 0,
          });
          if (live.length > 0) return live[0];
        } catch (err) {
          console.error(
            `[agoda-search] live price fetch failed for hotel ${pick.hotelId} (attempt ${attempt + 1}):`,
            err instanceof Error ? err.message : err
          );
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return null;
    })
  );

  const found = results.filter((r) => r !== null).length;
  console.log(`[agoda-search] Stage B: fetched live prices for ${found}/${picks.length} picks`);

  return picks.map((pick, i) => {
    const l = results[i];
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

// ---------------------------------------------------------------------------
// Direct lookup by name — for when the traveller names a specific hotel that isn't (or
// is no longer) part of the currently active ranked search. Real example: a search got
// re-run with a budget constraint, which dropped a pricier hotel from the picks; the
// traveller then said "I'll book the [that hotel]" — nothing resolved it because it
// genuinely wasn't in agodaSmart.picks anymore. This looks the name up directly against
// the local DB (not the ranked candidate pool) and fetches its live price/landingURL on
// its own, independent of whatever search is currently active.
// ---------------------------------------------------------------------------

export async function findHotelPickByName(
  cityQuery: string,
  nameQuery: string,
  params: { checkinDate: string; checkoutDate: string; adults?: number; children?: number; countryHint?: string | null }
): Promise<HotelPick | null> {
  const cityMatches = findCity(cityQuery, params.countryHint);
  if (cityMatches.length === 0) return null;
  const resolvedCity = cityMatches[0];

  if (!isAgodaDbAvailable()) return null;

  const rows = searchHotelsByNameInCity(resolvedCity.city_id, nameQuery, 5).filter((r) => !isLikelyNonBookable(r));
  if (rows.length === 0) {
    console.log(`[agoda-search] no DB match for "${nameQuery}" in ${resolvedCity.city}`);
    return null;
  }

  const best = rows[0]; // highest-rated of the name matches
  const [priced] = await fetchLiveAgodaPrices([toPick(best, null, `You chose this one.`)], params);
  console.log(
    `[agoda-search] resolved "${nameQuery}" -> ${best.hotel_name} (${best.hotel_id}), live=${priced.liveDailyRate !== undefined}`
  );
  return priced;
}
