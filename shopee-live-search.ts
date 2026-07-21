/**
 * shopee-live-search.ts
 *
 * Live Shopee keyword search via Charted Sea (see charted-sea-client.ts) —
 * COMMIT-TIME PRICE-CHECK ONLY (see shopee-price-check.ts). Deliberately never
 * called inline during normal recommendation turns: verified live 2026-07-06 that
 * Shopee's web scraper can take 2+ minutes and fail outright
 * (BLOCKED_TOO_MANY_TIMES) even on a plain keyword search — a real, routine
 * failure mode, unlike Lazada's fast/reliable equivalent (lazada-search.ts).
 * Reserved for the one moment that latency is acceptable: after a shopper commits
 * to a specific product, checking whether Shopee has the same/a cheaper item is
 * worth a real wait.
 *
 * Uses the cheap /api/v4/search/search_items endpoint, NOT the 2x-priced
 * /api/v4/pdp/get_pc detail endpoint — confirmed live that rating_star,
 * rating_count (the true review count) and is_official_shop are all already
 * present on the search response, so no separate detail call is needed just to
 * rank candidates.
 */

import { runScrapingTask } from "./charted-sea-client.js";
import type { RankableCandidate } from "./product-ranking.js";

// Confirmed against real product_url values already present in the local Shopee
// datafeed (product-refresh.ts) — e.g. MY resolves to shopee.com.my, not shopee.my.
const SHOPEE_TLD: Record<string, string> = {
  SG: "sg",
  MY: "com.my",
  TH: "co.th",
  PH: "ph",
  ID: "co.id",
  VN: "vn",
  TW: "tw",
};

const SHOPEE_CURRENCY: Record<string, string> = {
  SG: "SGD",
  MY: "MYR",
  PH: "PHP",
  TH: "THB",
  TW: "TWD",
  ID: "IDR",
  VN: "VND",
};

// Exported (2026-07-2x, "try Shopee too") so product-search.ts/agent.ts can check
// country availability before scheduling a background live-Shopee search as a
// last-resort supplement when local datafeed + Lazada both come up empty — mirrors
// LAZADA_PRESENCE_COUNTRIES in lazada-search.ts.
export const SHOPEE_LIVE_PRESENCE_COUNTRIES = new Set(Object.keys(SHOPEE_TLD));

interface ShopeeItemRating {
  rating_star?: number;
  // [total, 1-star, 2-star, 3-star, 4-star, 5-star] — index 0 is the true review
  // count, confirmed live 2026-07-06 (sum of indices 1-5 matches index 0 exactly).
  rating_count?: number[];
}

interface ShopeeItemBasic {
  itemid: number;
  shopid: number;
  name: string;
  price: number; // integer, divide by 100000 for the real price — see Charted Sea's Shopee docs
  price_before_discount?: number;
  image?: string;
  is_official_shop?: boolean;
  item_rating?: ShopeeItemRating;
  stock?: number | null;
}

interface ShopeeSearchResponse {
  total_count?: number;
  items?: Array<{ item_basic: ShopeeItemBasic }>;
}

export async function searchShopeeLive(params: {
  query: string;
  country: string;
  maxWaitMs?: number;
}): Promise<RankableCandidate[] | null> {
  const country = params.country.toUpperCase();
  const tld = SHOPEE_TLD[country];
  if (!tld) return null;

  const url = `https://shopee.${tld}/api/v4/search/search_items?keyword=${encodeURIComponent(params.query)}`;
  // Shopee's own retry-on-block behaviour happens server-side inside Charted Sea
  // (up to 3 attempts per their docs) — give it real room to actually finish before
  // we give up, per the live test that took ~2.5min including two blocked retries.
  const body = (await runScrapingTask("shopee", url, {
    maxWaitMs: params.maxWaitMs ?? 170_000,
    pollIntervalMs: 8_000,
  })) as ShopeeSearchResponse | null;

  if (!body?.items) {
    console.log(`[shopee-live-search] no result for "${params.query}" in ${country}`);
    return null;
  }

  console.log(`[shopee-live-search] "${params.query}" (${country}): ${body.total_count ?? body.items.length} total, ${body.items.length} returned`);

  const currency = SHOPEE_CURRENCY[country] ?? null;

  return body.items.map(({ item_basic: ib }): RankableCandidate => {
    const price = ib.price != null ? ib.price / 100000 : null;
    const priceBeforeDiscount = ib.price_before_discount != null ? ib.price_before_discount / 100000 : null;
    return {
      source: "shopee_live",
      merchant: "shopee",
      productId: String(ib.itemid),
      shopId: String(ib.shopid),
      title: ib.name,
      category: null,
      brand: null,
      price: priceBeforeDiscount ?? price,
      salePrice: price,
      currency,
      rating: ib.item_rating?.rating_star ?? null,
      reviewCount: ib.item_rating?.rating_count?.[0] ?? null,
      soldCount: null, // not available in unauthenticated search — see Charted Sea's Shopee docs
      isOfficial: !!ib.is_official_shop,
      isAd: false, // no ad/sponsored flag observed on this endpoint's response shape
      inStock: ib.stock == null || ib.stock > 0,
      productUrl: `https://shopee.${tld}/product/${ib.shopid}/${ib.itemid}`,
      imageUrl: ib.image ? `https://down-${country.toLowerCase()}.img.susercontent.com/file/${ib.image}` : null,
    };
  });
}
