/**
 * lazada-search.ts
 *
 * Live Lazada keyword search via Charted Sea (see charted-sea-client.ts). Unlike the
 * Shopee side of this integration, Lazada essentially always eventually succeeds —
 * confirmed directly against Charted Sea's own "Scraping Tasks" dashboard (100%
 * success rate observed) rather than assumed. What it ISN'T is fast: real measured
 * latency ranges from ~12s up to 70s+ depending on Charted Sea's queue load, with no
 * fixed inline timeout able to reliably catch the slow end without starving the rest
 * of agent.ts's reply pipeline (see product-search.ts's history of timeout bumps —
 * 12s, 18s, 28s, 45s — that each got beaten by a slower real request).
 *
 * Given it (almost) always finishes, just not necessarily in time for the reply,
 * this is now a two-phase API (added 2026-07-2x, "checking Lazada" decision):
 * startLazadaSearch submits and returns instantly; continueLazadaSearch can be called
 * once inline (a short, genuinely opportunistic peek) and again later from a
 * background job with a much longer budget, sending the results as a follow-up
 * message once they land — see agent.ts's pollPendingLazadaAndFollowUp. searchLazadaProducts
 * (submit + wait, no resume) is kept as a plain single-call convenience wrapper.
 *
 * Lazada's own search response already includes rating/reviewCount/soldCount/
 * isAd/isSponsored/isLazMall directly — no separate detail call needed — and
 * pageUrl is already a clean, direct, unwrapped SKU link. Matches Yixin's explicit
 * "direct link, no ACP mint" policy already in place for Shopee/Agoda/iHerb (see
 * agent.ts's buildBookingLinkMessage comment) — Lazada gets the exact same
 * treatment, never routed through acpMintLink.
 */

import { submitScrapingTask, pollScrapingTaskUntil } from "./charted-sea-client.js";
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

function mapLazadaResponse(body: LazadaSearchResponse | null, query: string, country: string): RankableCandidate[] | null {
  if (!body?.products) {
    console.log(`[lazada-search] no result for "${query}" in ${country}`);
    return null;
  }

  console.log(
    `[lazada-search] "${query}" (${country}): ${body.productTotal ?? body.products.length} total, ${body.products.length} returned`
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

/** A submitted-but-not-yet-resolved Lazada search — hand this to continueLazadaSearch
 *  later (possibly much later, from a background job) to keep checking on it. See
 *  startLazadaSearch's header comment for why this two-phase shape exists. */
export interface LazadaSearchHandle {
  uuid: string;
  query: string;
  country: string; // already uppercased
}

/**
 * Phase 1 of the "reply now, follow up later" flow (decided 2026-07-2x — see project
 * memory "Charted Sea live search eval," the "checking Lazada" pass): submits the
 * search and returns immediately (~1s), without waiting for it to finish at all.
 * Charted Sea's own dashboard confirmed Lazada searches succeed essentially every
 * time — they just routinely take 45-70s+, which is longer than any budget we can
 * afford to block a chat reply on. Returns null only when this country isn't a
 * Lazada market, or the submit call itself fails (bad token, HTTP error).
 */
export async function startLazadaSearch(params: { query: string; country: string }): Promise<LazadaSearchHandle | null> {
  const country = params.country.toUpperCase();
  const tld = LAZADA_TLD[country];
  if (!tld) return null; // not a Lazada market — caller should just skip this source

  const url = `https://www.lazada.${tld}/catalog/?q=${encodeURIComponent(params.query)}`;
  const uuid = await submitScrapingTask("lazada", url);
  if (!uuid) return null;
  return { uuid, query: params.query, country };
}

/**
 * Phase 2: check on a handle from startLazadaSearch for up to maxWaitMs. Safe to call
 * more than once against the same handle (e.g. once as a short opportunistic inline
 * peek, then again later from a background follow-up job with a much longer budget) —
 * giving up here never cancels the underlying task.
 */
export async function continueLazadaSearch(
  handle: LazadaSearchHandle,
  opts: { maxWaitMs?: number; pollIntervalMs?: number } = {}
): Promise<RankableCandidate[] | null> {
  const body = (await pollScrapingTaskUntil("lazada", handle.uuid, opts)) as LazadaSearchResponse | null;
  return mapLazadaResponse(body, handle.query, handle.country);
}

/** Single-call convenience wrapper (submit + wait, no resume) — kept for callers that
 *  don't need the two-phase split, mirrors charted-sea-client.ts's runScrapingTask. */
export async function searchLazadaProducts(params: {
  query: string;
  country: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}): Promise<RankableCandidate[] | null> {
  const handle = await startLazadaSearch(params);
  if (!handle) return null;
  return continueLazadaSearch(handle, { maxWaitMs: params.maxWaitMs ?? 45_000, pollIntervalMs: params.pollIntervalMs ?? 5_000 });
}
