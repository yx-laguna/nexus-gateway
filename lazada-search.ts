/**
 * lazada-search.ts
 *
 * Live Lazada keyword search via Charted Sea (see charted-sea-client.ts). Unlike
 * the Shopee side of this integration, Lazada's scrape is fast and reliable enough
 * (verified live 2026-07-06: ~25s, zero blocks on the same test that got Shopee
 * blocked twice) to call inline on every recommendation turn — see
 * product-search.ts's searchCombinedProducts.
 *
 * Lazada's own search response already includes rating/reviewCount/soldCount/
 * isAd/isSponsored/isLazMall directly — no separate detail call needed — and
 * pageUrl is already a clean, direct, unwrapped SKU link. Matches Yixin's explicit
 * "direct link, no ACP mint" policy already in place for Shopee/Agoda/iHerb (see
 * agent.ts's buildBookingLinkMessage comment) — Lazada gets the exact same
 * treatment, never routed through acpMintLink.
 */

import { runScrapingTask } from "./charted-sea-client.js";
import type { RankableCandidate } from "./product-ranking.js";

// Lazada's own country top-level domains — SEA markets only (Lazada doesn't operate
// in the LatAm markets Charted Sea's health-metrics endpoint lists for Shopee).
const LAZADA_TLD: Record<string, string> = {
  SG: "sg",
  MY: "com.my",
  TH: "co.th",
  PH: "com.ph",
  ID: "co.id",
  VN: "vn",
};

const LAZADA_CURRENCY: Record<string, string> = {
  SG: "SGD",
  MY: "MYR",
  TH: "THB",
  PH: "PHP",
  ID: "IDR",
  VN: "VND",
};

export const LAZADA_PRESENCE_COUNTRIES = new Set(Object.keys(LAZADA_TLD));

interface LazadaApiProduct {
  itemId: number;
  pageUrl: string;
  name: string;
  imageUrl?: string;
  price: number;
  originalPrice?: number;
  isInStock?: boolean;
  isAd?: boolean;
  isSponsored?: boolean;
  isLazMall?: boolean;
  ratingScore?: number;
  reviewCount?: number;
  soldCount?: number;
  shopId?: number;
}

interface LazadaSearchResponse {
  productTotal?: number;
  products?: LazadaApiProduct[];
}

export async function searchLazadaProducts(params: {
  query: string;
  country: string;
  maxWaitMs?: number;
}): Promise<RankableCandidate[] | null> {
  const country = params.country.toUpperCase();
  const tld = LAZADA_TLD[country];
  if (!tld) return null; // not a Lazada market — caller should just skip this source

  const url = `https://www.lazada.${tld}/catalog/?q=${encodeURIComponent(params.query)}`;
  const body = (await runScrapingTask("lazada", url, {
    maxWaitMs: params.maxWaitMs ?? 45_000,
  })) as LazadaSearchResponse | null;

  if (!body?.products) {
    console.log(`[lazada-search] no result for "${params.query}" in ${country}`);
    return null;
  }

  console.log(
    `[lazada-search] "${params.query}" (${country}): ${body.productTotal ?? body.products.length} total, ${body.products.length} returned`
  );

  const currency = LAZADA_CURRENCY[country] ?? null;

  return body.products.map(
    (p): RankableCandidate => ({
      source: "lazada_live",
      merchant: "lazada",
      productId: String(p.itemId),
      shopId: p.shopId != null ? String(p.shopId) : null,
      title: p.name,
      category: null,
      brand: null,
      price: p.originalPrice ?? p.price ?? null,
      salePrice: p.price ?? null,
      currency,
      rating: p.ratingScore ?? null,
      reviewCount: p.reviewCount ?? null,
      soldCount: p.soldCount ?? null,
      isOfficial: p.isLazMall ?? false,
      isAd: !!(p.isAd || p.isSponsored),
      inStock: p.isInStock ?? true,
      productUrl: p.pageUrl,
      imageUrl: p.imageUrl ?? null,
    })
  );
}
