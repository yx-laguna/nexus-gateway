/**
 * agoda-api.ts
 *
 * Direct client for the Agoda Affiliate Long Tail Search API (v1, "lt_v1").
 * Docs: Affiliate_Lite_API_V2.0.pdf. This is a search-only API — there is no
 * booking endpoint. Every result's landingURL is a real, dated, hotel-specific
 * affiliate deep link (cid=<AGODA_SITE_ID> baked in) — that IS the "dedicated
 * booking URL", no extra construction needed on our side.
 */

import "dotenv/config";

const ENDPOINT = process.env.AGODA_API_URL ?? "http://affiliateapi7643.agoda.com/affiliateservice/lt_v1";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function authHeader(): string {
  // Format: "<siteId>:<apiKey>" — must match siteid/apikey duplicated in the body per the spec.
  return `${requireEnv("AGODA_SITE_ID")}:${requireEnv("AGODA_API_KEY")}`;
}

export interface AgodaSearchResult {
  hotelId: number;
  hotelName: string;
  starRating: number;
  reviewScore: number;
  reviewCount?: number;
  currency: string;
  dailyRate: number;
  crossedOutRate?: number;
  discountPercentage?: number;
  imageURL?: string;
  landingURL: string;
  includeBreakfast: boolean;
  freeWifi: boolean;
  roomTypeName?: string; // only present on hotel-list search
}

export type AgodaSortBy =
  | "Recommended"
  | "PriceAsc"
  | "PriceDesc"
  | "StarRatingDesc"
  | "StarRatingAsc"
  | "AllGuestsReviewScore";

export interface CitySearchParams {
  cityId: number;
  checkInDate: string; // YYYY-MM-DD
  checkOutDate: string; // YYYY-MM-DD
  adults?: number;
  children?: number;
  childrenAges?: number[];
  currency?: string;
  maxResult?: number; // 1-30, city search only
  sortBy?: AgodaSortBy;
  minimumStarRating?: number; // 0-5
  minimumReviewScore?: number; // 0-10
  dailyRateMin?: number;
  dailyRateMax?: number;
  discountOnly?: boolean;
  language?: string;
}

export interface HotelListSearchParams {
  hotelIds: number[];
  checkInDate: string;
  checkOutDate: string;
  adults?: number;
  children?: number;
  currency?: string;
  language?: string;
}

interface RawResult {
  hotelId: number | string;
  hotelName?: string;
  starRating?: number | string;
  reviewScore?: number | string;
  reviewCount?: number | string;
  currency?: string;
  dailyRate?: number | string;
  crossedOutRate?: number | string;
  discountPercentage?: number | string;
  imageURL?: string;
  landingURL?: string;
  includeBreakfast?: boolean;
  freeWifi?: boolean;
  roomtypeName?: string;
}

interface RawResponse {
  results?: RawResult[];
  error?: { id: number; message: string };
}

function mapResult(r: RawResult): AgodaSearchResult {
  return {
    hotelId: Number(r.hotelId),
    hotelName: String(r.hotelName ?? ""),
    starRating: Number(r.starRating ?? 0),
    reviewScore: Number(r.reviewScore ?? 0),
    reviewCount: r.reviewCount !== undefined ? Number(r.reviewCount) : undefined,
    currency: String(r.currency ?? "USD"),
    dailyRate: Number(r.dailyRate ?? 0),
    crossedOutRate: r.crossedOutRate !== undefined ? Number(r.crossedOutRate) : undefined,
    discountPercentage: r.discountPercentage !== undefined ? Number(r.discountPercentage) : undefined,
    imageURL: r.imageURL,
    landingURL: String(r.landingURL ?? ""),
    includeBreakfast: Boolean(r.includeBreakfast),
    freeWifi: Boolean(r.freeWifi),
    roomTypeName: r.roomtypeName,
  };
}

const FETCH_TIMEOUT_MS = 15_000;

async function callLongTailSearch(criteria: Record<string, unknown>): Promise<AgodaSearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip,deflate",
        Authorization: authHeader(),
      },
      body: JSON.stringify({ criteria }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  let parsed: RawResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`[agoda-api] unparseable response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  if (parsed.error) {
    // id 911 = "No search result" per the appendix — treat as an empty result, not fatal.
    if (parsed.error.id === 911) return [];
    throw new Error(`[agoda-api] error ${parsed.error.id}: ${parsed.error.message}`);
  }

  if (!res.ok) {
    throw new Error(`[agoda-api] HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return (parsed.results ?? []).map(mapResult);
}

/** City search — up to 30 hotels for a destination + dates, sortable/filterable. */
export async function searchHotelsByCity(params: CitySearchParams): Promise<AgodaSearchResult[]> {
  const criteria = {
    cityId: params.cityId,
    checkInDate: params.checkInDate,
    checkOutDate: params.checkOutDate,
    additional: {
      currency: params.currency ?? "USD",
      language: params.language ?? "en-us",
      maxResult: Math.min(Math.max(params.maxResult ?? 20, 1), 30),
      sortBy: params.sortBy ?? "Recommended",
      discountOnly: params.discountOnly ?? false,
      minimumStarRating: params.minimumStarRating ?? 0,
      minimumReviewScore: params.minimumReviewScore ?? 0,
      dailyRate: {
        minimum: params.dailyRateMin ?? 0,
        maximum: params.dailyRateMax ?? 100000,
      },
      occupancy: {
        numberOfAdult: params.adults ?? 2,
        numberOfChildren: params.children ?? 0,
        ...(params.childrenAges ? { childrenAges: params.childrenAges } : {}),
      },
    },
  };

  console.log(`[agoda-api] city search cityId=${params.cityId} ${params.checkInDate} -> ${params.checkOutDate}`);
  return callLongTailSearch(criteria);
}

/** Hotel list search — live pricing for a specific set of known hotel IDs. */
export async function searchHotelsByIds(params: HotelListSearchParams): Promise<AgodaSearchResult[]> {
  const criteria = {
    hotelId: params.hotelIds,
    checkInDate: params.checkInDate,
    checkOutDate: params.checkOutDate,
    additional: {
      currency: params.currency ?? "USD",
      language: params.language ?? "en-us",
      discountOnly: false,
      occupancy: {
        numberOfAdult: params.adults ?? 2,
        numberOfChildren: params.children ?? 0,
      },
    },
  };

  console.log(`[agoda-api] hotel list search — ${params.hotelIds.length} hotel(s)`);
  return callLongTailSearch(criteria);
}
