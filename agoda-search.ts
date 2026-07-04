/**
 * agoda-search.ts
 *
 * The new feature: "smart" Agoda hotel search.
 *
 *   1. Resolve the destination the user mentioned to an Agoda city ID
 *      (agoda-city-lookup.ts, built from Agoda_Hotels_EN.csv).
 *   2. Call the real Agoda Long Tail Search API for that city + dates
 *      (agoda-api.ts) — up to 30 live, priced, bookable hotels.
 *   3. Enrich each candidate with address/geo/description from the local
 *      hotel DB (agoda-db.ts) — the API alone doesn't return an address.
 *   4. Hand the enriched candidate list to Kimi (via broker.chat, same
 *      Virtuals Agent Compute path the rest of the bot uses) and ask it to
 *      rank the top 3 against whatever the user said mattered to them
 *      (distance/vibe/price/etc — free text, not a fixed filter).
 *
 * The winning pick's landingURL from the live API response IS the dedicated,
 * hotel-specific, dated booking link — cid=<AGODA_SITE_ID> is already baked
 * in by Agoda, so there's nothing further to construct.
 */

import { chat, type ChatMessage } from "./broker.js";
import { findCity, type CityMatch } from "./agoda-city-lookup.js";
import { searchHotelsByCity, type AgodaSearchResult } from "./agoda-api.js";
import { getHotelsByIds, isAgodaDbAvailable } from "./agoda-db.js";

export interface SmartSearchParams {
  cityQuery: string;
  checkinDate: string; // YYYY-MM-DD
  checkoutDate: string; // YYYY-MM-DD
  adults?: number;
  children?: number;
  budgetMaxPerNight?: number;
  starMin?: number;
  reviewMin?: number;
  preferenceText?: string; // free text: "near the beach", "quiet, close to MRT", etc.
  countryHint?: string | null; // ISO alpha-2 — narrows city name collisions
}

export interface HotelPick {
  hotelId: number;
  hotelName: string;
  dailyRate: number;
  currency: string;
  starRating: number;
  reviewScore: number;
  landingURL: string;
  reasoning: string;
}

export interface SmartSearchResult {
  resolvedCity: CityMatch;
  candidateCount: number;
  picks: HotelPick[];
}

function fallbackPicks(results: AgodaSearchResult[]): HotelPick[] {
  return [...results]
    .sort((a, b) => b.reviewScore - a.reviewScore)
    .slice(0, 3)
    .map((hotel) => ({
      hotelId: hotel.hotelId,
      hotelName: hotel.hotelName,
      dailyRate: hotel.dailyRate,
      currency: hotel.currency,
      starRating: hotel.starRating,
      reviewScore: hotel.reviewScore,
      landingURL: hotel.landingURL,
      reasoning: "Top-rated match for your dates (Kimi ranking unavailable — sorted by review score).",
    }));
}

export async function smartSearchHotels(params: SmartSearchParams): Promise<SmartSearchResult | null> {
  const cityMatches = findCity(params.cityQuery, params.countryHint);
  if (cityMatches.length === 0) {
    console.warn(`[agoda-search] no city match for "${params.cityQuery}"`);
    return null;
  }
  const resolvedCity = cityMatches[0];

  let results: AgodaSearchResult[];
  try {
    results = await searchHotelsByCity({
      cityId: resolvedCity.city_id,
      checkInDate: params.checkinDate,
      checkOutDate: params.checkoutDate,
      adults: params.adults ?? 2,
      children: params.children ?? 0,
      maxResult: 25,
      sortBy: params.budgetMaxPerNight ? "PriceAsc" : "Recommended",
      minimumStarRating: params.starMin ?? 0,
      minimumReviewScore: params.reviewMin ?? 0,
      dailyRateMax: params.budgetMaxPerNight,
    });
  } catch (err) {
    console.error(`[agoda-search] API search failed:`, err instanceof Error ? err.message : err);
    return null;
  }

  if (results.length === 0) {
    console.log(`[agoda-search] 0 results for ${resolvedCity.city} (${resolvedCity.city_id})`);
    return null;
  }

  // Enrich with address/geo/overview from the local hotel DB — best effort,
  // ranking still works from live API fields alone if the DB is unavailable.
  const enrichment = isAgodaDbAvailable() ? getHotelsByIds(results.map((r) => r.hotelId)) : new Map();

  const candidates = results.map((r) => {
    const extra = enrichment.get(r.hotelId);
    return {
      hotel_id: r.hotelId,
      name: r.hotelName,
      price_per_night: r.dailyRate,
      currency: r.currency,
      star_rating: r.starRating,
      review_score: r.reviewScore,
      discount_pct: r.discountPercentage ?? 0,
      breakfast_included: r.includeBreakfast,
      free_wifi: r.freeWifi,
      address: extra?.address ?? null,
      accommodation_type: extra?.accommodation_type ?? null,
      description: extra?.overview ?? null,
    };
  });

  const rankingPrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a hotel-ranking engine for a travel concierge bot. You will be given a JSON list of ` +
        `real, live, bookable hotel candidates (real prices, ratings, addresses, short descriptions) ` +
        `plus a traveller's stated preferences. Pick the 3 best matches for this specific traveller and ` +
        `explain each pick in one short, concrete sentence (mention the actual reason — price, location, ` +
        `rating — don't be generic).\n\n` +
        `Weigh price against budget_max_per_night if given, location/address hints against ` +
        `traveller_preferences, star rating, and review score. Never invent hotels, prices, or facts not ` +
        `present in the candidate list — only choose from the given hotel_id values.\n\n` +
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

  let picks: HotelPick[] = [];
  try {
    const raw = await chat(rankingPrompt, true);
    const parsed = JSON.parse(raw) as { picks?: Array<{ hotel_id: number; reasoning: string }> };
    const byId = new Map(results.map((r) => [r.hotelId, r]));

    picks = (parsed.picks ?? [])
      .map((p): HotelPick | null => {
        const hotel = byId.get(Number(p.hotel_id));
        if (!hotel) return null;
        return {
          hotelId: hotel.hotelId,
          hotelName: hotel.hotelName,
          dailyRate: hotel.dailyRate,
          currency: hotel.currency,
          starRating: hotel.starRating,
          reviewScore: hotel.reviewScore,
          landingURL: hotel.landingURL,
          reasoning: p.reasoning,
        };
      })
      .filter((p): p is HotelPick => p !== null)
      .slice(0, 3);
  } catch (err) {
    console.warn(
      `[agoda-search] Kimi ranking failed, falling back to top-3 by review score:`,
      err instanceof Error ? err.message : err
    );
  }

  if (picks.length === 0) picks = fallbackPicks(results);

  console.log(
    `[agoda-search] ${resolvedCity.city} (${resolvedCity.city_id}): ${results.length} candidates -> ${picks.length} picks`
  );

  return { resolvedCity, candidateCount: results.length, picks };
}
