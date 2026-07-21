/**
 * product-search.ts
 *
 * Local-first retail product search — the Shopee/iHerb equivalent of
 * agoda-search.ts's Stage A. There's no Stage B here (no live-price-check API
 * the way Agoda has one for hotels): the datafeed's own price IS what we show,
 * refreshed whenever the catalog is re-ingested (see scripts/build-products-db.py).
 *
 *   1. FTS5 keyword search against the local catalog (product-db.ts), scoped to
 *      the shopper's country — a query like "toothbrush" can match thousands of
 *      rows across a 100k+-row country catalog, so this is a fast, cheap,
 *      no-LLM retrieval step, same division of labour as Agoda's local DB pull.
 *   2. A heuristic pre-sort/cap (rating + sold-count + official/preferred-shop
 *      trust signals) down to a bounded candidate pool BEFORE ever calling Kimi —
 *      dumping thousands of raw rows into an LLM prompt would be slow and
 *      wasteful, the same lesson learned building the hotel pipeline.
 *   3. Kimi picks/explains a small, diverse shortlist from that capped pool
 *      against the shopper's actual phrasing and any stated budget.
 *
 * No ACP mint / affiliate-link wrapping happens here at all — deliberately out
 * of scope for this pass (discovery/recommendation first, monetization once the
 * Shopee/iHerb affiliate mechanics are sorted — see project memory). Picks carry
 * the raw product_url as-is.
 *
 * searchLocalProducts above is the original local-only (Shopee/iHerb datafeed)
 * path. searchCombinedProducts (added 2026-07-06) additionally pools in live
 * Lazada search results (lazada-search.ts) and is what agent.ts actually calls
 * today — see its own header comment for why Lazada joins this fast/inline path
 * while live Shopee search does not.
 */

import { chat, type ChatMessage } from "./broker.js";
import { searchProductCandidates, searchProductsByTitle, isProductsDbAvailable, type ProductRow } from "./product-db.js";
import {
  scoreCandidate,
  applyHardFilters,
  shortlist,
  titleMatchesQuery,
  type RankableCandidate,
} from "./product-ranking.js";
import { startLazadaSearch, continueLazadaSearch, LAZADA_PRESENCE_COUNTRIES, type LazadaSearchHandle } from "./lazada-search.js";

const STAGE_A_RANKING_TIMEOUT_MS = 20_000;

// History (2026-07-06): this used to be a single INLINE_LAZADA_TIMEOUT_MS that kept
// getting raised — 12s, 18s, 28s, 45s — each time beaten by a real, slower request
// (see project memory "Charted Sea live search eval" for the full sequence, including
// the MY "frying pan"/"running shoes" incidents and the SG "coke" incident that
// confirmed via Charted Sea's own dashboard that Lazada essentially always succeeds,
// just not necessarily within any budget we can afford to block a reply on).
//
// Decided 2026-07-2x ("checking Lazada"): stop trying to find a timeout that fits.
// Give Lazada a short, genuinely opportunistic peek — just long enough to catch the
// occasional fast case (VN succeeded in ~12s in one live test) — and if it's not done
// by then, reply with whatever's available (local datafeed, or an honest "still
// checking" message) and let agent.ts's pollPendingLazadaAndFollowUp keep polling the
// same task in the background, sending a follow-up message once it actually lands.
// See searchCombinedProducts' pendingLazada field.
const INLINE_LAZADA_PEEK_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export interface ProductSearchParams {
  query: string; // free text, e.g. "toothbrush", "vitamin c serum"
  country: string; // ISO alpha-2 — selects which country's catalog to search
  merchants?: string[]; // restrict to these merchants (e.g. ["iherb"]) — omit to search all locally-catalogued merchants for this country
  budgetMax?: number; // optional max price filter (sale_price if present, else price)
  excludeProductIds?: string[]; // leave out — used when the shopper explicitly wants different options
}

export interface ProductPick {
  productId: string;
  merchant: string;
  title: string;
  price: number | null;
  salePrice: number | null;
  currency: string | null;
  rating: number | null;
  // True number-of-ratings when the source has one (Lazada, live Shopee search) —
  // null for anything sourced from the local datafeed, which never carries this
  // field (see product-ranking.ts). Purely for display; soldCount below is used
  // wherever reviewCount is null.
  reviewCount: number | null;
  soldCount: number | null;
  isOfficial: boolean;
  category: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  reasoning: string;
}

/** Human-readable marketplace label for display — picks can now come from more
 *  than one platform in the same shortlist (see searchCombinedProducts), so every
 *  place a pick is shown needs to say which marketplace it's on. */
export function platformLabel(merchant: string): string {
  switch (merchant) {
    case "lazada":
      return "Lazada";
    case "shopee":
      return "Shopee";
    case "iherb":
      return "iHerb";
    default:
      return merchant;
  }
}

export interface ProductSearchResult {
  query: string;
  country: string;
  candidateCount: number;
  picks: ProductPick[];
  // False when no candidate actually had the query in its title (see
  // titleMatchesQuery) — picks are the closest available items from the broader
  // FTS pool, not confirmed matches. Callers should frame these as "similar items"
  // rather than presenting them as if they satisfy the request.
  isExactMatch: boolean;
  // Set when searchCombinedProducts kicked off a Lazada search that hadn't finished
  // by the time this result needed to go out (see INLINE_LAZADA_PEEK_MS). agent.ts's
  // pollPendingLazadaAndFollowUp picks this up and keeps checking in the background,
  // sending a follow-up message with any real results once they land. Undefined means
  // either Lazada isn't a market here, it already settled (results are already merged
  // into picks above), or the search wasn't attempted at all.
  pendingLazada?: LazadaSearchHandle;
}

function effectivePrice(row: ProductRow): number | null {
  return row.sale_price ?? row.price ?? null;
}

function toPick(row: ProductRow, reasoning: string): ProductPick {
  return {
    productId: row.product_id,
    merchant: row.merchant,
    title: row.title ?? `${row.merchant} product #${row.product_id}`,
    price: row.price,
    salePrice: row.sale_price,
    currency: row.currency,
    rating: row.rating,
    reviewCount: null, // local datafeed never carries a true review count
    soldCount: row.sold_count,
    isOfficial: row.is_official === 1,
    category: row.category,
    productUrl: row.product_url,
    imageUrl: row.image_url,
    reasoning,
  };
}

function candidateToPick(c: RankableCandidate, reasoning: string): ProductPick {
  return {
    productId: c.productId,
    merchant: c.merchant,
    title: c.title || `${c.merchant} product #${c.productId}`,
    price: c.price,
    salePrice: c.salePrice,
    currency: c.currency,
    rating: c.rating,
    reviewCount: c.reviewCount,
    soldCount: c.soldCount,
    isOfficial: c.isOfficial,
    category: c.category,
    productUrl: c.productUrl,
    imageUrl: c.imageUrl,
    reasoning,
  };
}

/** Heuristic trust/popularity score used to pre-sort BEFORE the LLM ever sees the
 *  pool — rating alone rewards a 5.0 with one review as much as a 5.0 with 10,000;
 *  weighting by log(sold_count) means genuine popularity actually counts, and an
 *  official/preferred shop gets a modest trust boost (same spirit as Agoda's
 *  star_rating-as-luxury-signal decision: prefer a real, checkable signal over
 *  free-form text). */
function heuristicScore(row: ProductRow): number {
  const rating = row.rating ?? 3.5; // unrated items shouldn't zero out entirely
  const sold = Math.log((row.sold_count ?? 0) + 2);
  const trust = (row.is_official === 1 ? 1.15 : 1) * (row.is_preferred === 1 ? 1.05 : 1);
  return rating * sold * trust;
}

export async function searchLocalProducts(params: ProductSearchParams): Promise<ProductSearchResult | null> {
  if (!isProductsDbAvailable()) {
    console.warn(`[product-search] local product DB unavailable — cannot run local search`);
    return null;
  }

  let rows = searchProductCandidates({
    query: params.query,
    country: params.country,
    merchants: params.merchants,
    inStockOnly: true,
    limit: 300,
  });

  if (rows.length === 0) {
    console.log(`[product-search] 0 candidates for "${params.query}" in ${params.country}`);
    return null;
  }

  // Real bug (2026-07-06): FTS5 indexes title+description+category+brand with equal
  // weight, so a query like "toothbrush" can match a handful of rows purely via a
  // category-breadcrumb or description mention (e.g. an "Oral Care" listing that isn't
  // actually a toothbrush) with no real toothbrush in the catalog at all. Left
  // unfiltered, Kimi was forced to pick from that irrelevant pool and present a
  // mouthwash as the "closest match" to a toothbrush request, framed exactly like a
  // real recommendation — a real, purchasable, wrong-item link presented with
  // unearned confidence. Fixed by requiring the query to actually appear in the TITLE
  // before a row counts as an exact match. If that leaves nothing, we still show the
  // closest available items from the broader FTS pool (per explicit instruction — no
  // answer is worse UX than a hedged one) but tag the result isExactMatch=false so
  // buildReply can render a "couldn't find a great match, here's similar" intro
  // instead of presenting them as if they satisfy the request.
  const titleRelevant = rows.filter((r) => titleMatchesQuery(r.title, params.query));
  const isExactMatch = titleRelevant.length > 0;
  if (isExactMatch) {
    rows = titleRelevant;
  } else {
    console.log(
      `[product-search] "${params.query}" (${params.country}): ${rows.length} FTS candidates but none title-relevant — showing closest items, labelled as non-exact`
    );
  }

  if (params.excludeProductIds?.length) {
    const exclude = new Set(params.excludeProductIds);
    rows = rows.filter((r) => !exclude.has(r.product_id));
  }

  // Budget filter — same null-price leniency as Agoda's budget filter (don't drop a
  // product blind just because we don't have a price for it).
  if (params.budgetMax != null) {
    const budget = params.budgetMax;
    rows = rows.filter((r) => {
      const p = effectivePrice(r);
      return p === null || p <= budget;
    });
  }
  if (rows.length === 0) {
    console.log(`[product-search] budget filter (<=${params.budgetMax}) left 0 candidates`);
    return null;
  }

  const candidateCount = rows.length;
  const scored = [...rows].sort((a, b) => heuristicScore(b) - heuristicScore(a)).slice(0, 40);

  const candidates = scored.map((row) => ({
    product_id: row.product_id,
    merchant: row.merchant,
    title: row.title,
    category: row.category,
    brand: row.brand,
    price: row.price,
    sale_price: row.sale_price,
    currency: row.currency,
    rating: row.rating,
    sold_count: row.sold_count,
    is_official: row.is_official === 1,
  }));

  const rankingPrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a product-ranking engine for a shopping concierge bot. You'll get a JSON list of real ` +
        `product candidates from our own catalog (title, price, sale_price, rating, sold_count, ` +
        `is_official — a verified/official brand store) plus what the shopper actually asked for. Pick ` +
        `the 3-4 best, DIVERSE matches (don't return 4 near-identical variants of the same item unless ` +
        `that's genuinely all that's relevant) and explain each in one short, concrete sentence citing ` +
        `real facts from the candidate (price, rating, sold_count, official-store status) — never invent ` +
        `facts not in the list.\n\n` +
        `sale_price is the current price if present (price is the pre-discount reference price) — always ` +
        `reason about sale_price when both are given. Only choose from the given product_id values, never ` +
        `invent products.\n\n` +
        (isExactMatch
          ? ""
          : `None of these candidates are a confirmed match for what the shopper asked for — they're the ` +
            `closest items available in the catalog. Say so plainly in each reasoning sentence (e.g. "closest ` +
            `available option, not an exact match") rather than implying it's what they asked for.\n\n`) +
        `Return ONLY valid JSON, no explanation:\n` +
        `{ "picks": [ { "product_id": string, "merchant": string, "reasoning": string } ] } — 3 to 4 picks, best first.`,
    },
    {
      role: "user",
      content: JSON.stringify({
        shopper_query: params.query,
        budget_max: params.budgetMax ?? null,
        candidates,
      }),
    },
  ];

  let picks: ProductPick[] = [];
  try {
    const raw = await withTimeout(chat(rankingPrompt, true), STAGE_A_RANKING_TIMEOUT_MS, "product ranking");
    const parsed = JSON.parse(raw) as { picks?: Array<{ product_id: string; merchant: string; reasoning: string }> };
    const byKey = new Map(scored.map((row) => [`${row.merchant}:${row.product_id}`, row]));

    picks = (parsed.picks ?? [])
      .map((p): ProductPick | null => {
        const row = byKey.get(`${p.merchant}:${p.product_id}`);
        if (!row) return null;
        return toPick(row, p.reasoning);
      })
      .filter((p): p is ProductPick => p !== null)
      .slice(0, 4);
  } catch (err) {
    console.warn(`[product-search] Kimi ranking failed, falling back to top rows:`, err instanceof Error ? err.message : err);
  }

  if (picks.length === 0) {
    picks = scored
      .slice(0, 4)
      .map((row) =>
        toPick(row, isExactMatch ? "Top-rated, popular option matching your search." : "Closest available option — not an exact match.")
      );
  }

  console.log(
    `[product-search] "${params.query}" (${params.country}): ${candidateCount} candidates -> ${picks.length} picks (exactMatch=${isExactMatch})`
  );

  return { query: params.query, country: params.country, candidateCount, picks, isExactMatch };
}

/**
 * Shared ranking tail: given a pool of candidates from ANY source (local datafeed,
 * live Lazada, or both), apply the title-relevance guard, hard filters, shortlist,
 * and Kimi cross-platform ranking. Extracted (2026-07-2x) so both the main combined
 * search AND agent.ts's background Lazada follow-up (pollPendingLazadaAndFollowUp,
 * ranking a Lazada-only pool once it lands late) can share one ranking prompt/logic
 * instead of drifting into two copies. Returns null when the pool is empty or the
 * hard filters would wipe it out entirely with nothing to fall back to.
 */
export async function rankProductPool(params: {
  query: string;
  budgetMax?: number;
  pool: RankableCandidate[];
}): Promise<{ picks: ProductPick[]; isExactMatch: boolean; candidateCount: number } | null> {
  let pool = params.pool;
  if (pool.length === 0) return null;

  // Same title-relevance guard as the local-only search (see titleMatchesQuery's
  // header) — applied across whatever sources are pooled together, so none of them
  // can sneak an irrelevant result past on a non-title field.
  const titleRelevant = pool.filter((c) => titleMatchesQuery(c.title, params.query));
  const isExactMatch = titleRelevant.length > 0;
  if (isExactMatch) pool = titleRelevant;

  // Hard filters (ads/out-of-stock/budget/min-review-floor) — but if they'd wipe out
  // an otherwise-relevant pool entirely, degrade gracefully and show what we have
  // rather than nothing (same "no answer is worse than a hedged one" principle as
  // the isExactMatch fallback below).
  const filtered = applyHardFilters(pool, { budgetMax: params.budgetMax ?? undefined });
  const finalPool = filtered.length > 0 ? filtered : pool;
  if (finalPool.length === 0) return null;

  const candidateCount = finalPool.length;
  const scoredTop20 = shortlist(finalPool, 20);

  const candidatesForLLM = scoredTop20.map((c) => ({
    product_id: c.productId,
    merchant: c.merchant, // "shopee" | "iherb" | "lazada"
    title: c.title,
    price: c.price,
    sale_price: c.salePrice,
    currency: c.currency,
    rating: c.rating,
    review_count: c.reviewCount,
    sold_count: c.soldCount,
    is_official: c.isOfficial,
  }));

  const rankingPrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a product-ranking engine for a shopping concierge bot that searches multiple ` +
        `marketplaces at once (Shopee, Lazada, iHerb). You'll get a JSON list of real product ` +
        `candidates (title, price, sale_price, rating, review_count, sold_count, is_official) each ` +
        `tagged with which marketplace ("merchant") it's from, plus what the shopper actually asked ` +
        `for. Pick the 3-5 best, DIVERSE matches across marketplaces — don't return several ` +
        `near-identical variants of the same item from the same marketplace unless that's genuinely ` +
        `all that's relevant, and it's fine (good, even) to include picks from more than one ` +
        `marketplace if both have a genuinely good option; different marketplaces mean different ` +
        `checkout/delivery for the shopper, which is real, useful choice, not redundancy. Explain each ` +
        `pick in one short, concrete sentence citing real facts from the candidate (price, rating, ` +
        `review/sold count, official-store status) AND naming which marketplace it's on — never invent ` +
        `facts not in the list.\n\n` +
        `sale_price is the current price if present (price is the pre-discount reference price) — always ` +
        `reason about sale_price when both are given. Only choose from the given product_id+merchant ` +
        `pairs, never invent products.\n\n` +
        (isExactMatch
          ? ""
          : `None of these candidates are a confirmed match for what the shopper asked for — they're the ` +
            `closest items available. Say so plainly in each reasoning sentence rather than implying it's ` +
            `exactly what they asked for.\n\n`) +
        `Return ONLY valid JSON, no explanation:\n` +
        `{ "picks": [ { "product_id": string, "merchant": string, "reasoning": string } ] } — 3 to 5 picks, best first.`,
    },
    {
      role: "user",
      content: JSON.stringify({ shopper_query: params.query, budget_max: params.budgetMax ?? null, candidates: candidatesForLLM }),
    },
  ];

  let picks: ProductPick[] = [];
  try {
    const raw = await withTimeout(chat(rankingPrompt, true), STAGE_A_RANKING_TIMEOUT_MS, "combined product ranking");
    const parsed = JSON.parse(raw) as { picks?: Array<{ product_id: string; merchant: string; reasoning: string }> };
    const byKey = new Map(scoredTop20.map((c) => [`${c.merchant}:${c.productId}`, c]));

    picks = (parsed.picks ?? [])
      .map((p): ProductPick | null => {
        const c = byKey.get(`${p.merchant}:${p.product_id}`);
        if (!c) return null;
        return candidateToPick(c, p.reasoning);
      })
      .filter((p): p is ProductPick => p !== null)
      .slice(0, 5);
  } catch (err) {
    console.warn(`[product-search] combined Kimi ranking failed, falling back to top rows:`, err instanceof Error ? err.message : err);
  }

  if (picks.length === 0) {
    picks = scoredTop20
      .slice(0, 5)
      .map((c) =>
        candidateToPick(c, isExactMatch ? "Top-rated, popular option matching your search." : "Closest available option — not an exact match.")
      );
  }

  return { picks, isExactMatch, candidateCount };
}

/**
 * Combined Lazada (live) + Shopee/iHerb (local datafeed) search — decided
 * 2026-07-06 (see project memory "Charted Sea live search eval"): pools candidates
 * from both sources through the shared scoring formula (product-ranking.ts) and lets
 * Kimi pick 3-5 across BOTH platforms together rather than treating them as separate
 * lists.
 *
 * Reworked 2026-07-2x ("checking Lazada" decision): this no longer blocks the reply
 * on Lazada. The local datafeed query is synchronous/instant; Lazada is submitted and
 * given only a short opportunistic peek (INLINE_LAZADA_PEEK_MS) to land inline. If it
 * doesn't, the result carries a `pendingLazada` handle instead of Lazada candidates —
 * agent.ts's pollPendingLazadaAndFollowUp keeps checking in the background and sends
 * a follow-up message once real results arrive. This directly replaces the old
 * approach of just raising the inline timeout further (see INLINE_LAZADA_PEEK_MS's
 * comment for why that kept failing).
 *
 * The live Shopee scraper is still deliberately NOT part of this path — see
 * shopee-live-search.ts's header for why (routinely 2+ minutes, real block
 * failures) — it stays commit-time-only (shopee-price-check.ts).
 */
export async function searchCombinedProducts(params: ProductSearchParams): Promise<ProductSearchResult | null> {
  const country = params.country.toUpperCase();

  const localRows = isProductsDbAvailable()
    ? searchProductCandidates({
        query: params.query,
        country,
        merchants: params.merchants,
        inStockOnly: true,
        limit: 300,
      })
    : ([] as ProductRow[]);

  let lazadaHandle: LazadaSearchHandle | null = null;
  let lazadaCandidates: RankableCandidate[] | null = null;
  if (LAZADA_PRESENCE_COUNTRIES.has(country)) {
    try {
      lazadaHandle = await startLazadaSearch({ query: params.query, country });
      if (lazadaHandle) {
        lazadaCandidates = await continueLazadaSearch(lazadaHandle, { maxWaitMs: INLINE_LAZADA_PEEK_MS, pollIntervalMs: 3_000 });
      }
    } catch (err) {
      console.error(`[product-search] Lazada search failed:`, err instanceof Error ? err.message : err);
    }
  }
  // Lazada submitted OK but didn't land within the peek window — still genuinely in
  // flight server-side, not failed. Carry the handle forward so agent.ts can keep
  // checking on it and follow up later, instead of treating this like Lazada came up
  // empty.
  const stillPending = lazadaHandle !== null && lazadaCandidates === null;

  const localAsCandidates: RankableCandidate[] = localRows.map((r) => ({
    source: r.merchant === "iherb" ? "iherb_datafeed" : "shopee_datafeed",
    merchant: r.merchant,
    productId: r.product_id,
    shopId: r.shop_id,
    title: r.title ?? "",
    category: r.category,
    brand: r.brand,
    price: r.price,
    salePrice: r.sale_price,
    currency: r.currency,
    rating: r.rating,
    reviewCount: null, // local datafeed never carries a true review count — see product-ranking.ts
    soldCount: r.sold_count,
    isOfficial: r.is_official === 1,
    isAd: false,
    inStock: r.stock == null || r.stock > 0,
    productUrl: r.product_url ?? "",
    imageUrl: r.image_url,
  }));

  let pool: RankableCandidate[] = [...localAsCandidates, ...(lazadaCandidates ?? [])];

  if (params.excludeProductIds?.length) {
    const exclude = new Set(params.excludeProductIds);
    pool = pool.filter((c) => !exclude.has(c.productId));
  }

  if (pool.length === 0) {
    if (stillPending && lazadaHandle) {
      // Nothing to show YET, but Lazada is still genuinely in flight — return an
      // explicit "still checking" result (empty picks, pendingLazada set) rather than
      // null, so buildReply can say so honestly instead of falling back to a
      // fabricated "couldn't find anything" or LLM-guessed recs (see the "coke"
      // incident in feedback_search_reliability_patterns memory).
      console.log(`[product-search] 0 immediate candidates for "${params.query}" in ${country} — Lazada still in flight, will follow up`);
      return { query: params.query, country, candidateCount: 0, picks: [], isExactMatch: true, pendingLazada: lazadaHandle };
    }
    console.log(`[product-search] 0 combined candidates for "${params.query}" in ${country}`);
    return null;
  }

  const ranked = await rankProductPool({ query: params.query, budgetMax: params.budgetMax ?? undefined, pool });
  if (!ranked) {
    if (stillPending && lazadaHandle) {
      console.log(`[product-search] combined filters left 0 candidates for "${params.query}" in ${country} — Lazada still in flight, will follow up`);
      return { query: params.query, country, candidateCount: 0, picks: [], isExactMatch: true, pendingLazada: lazadaHandle };
    }
    console.log(`[product-search] combined filters left 0 candidates for "${params.query}" in ${country}`);
    return null;
  }

  console.log(
    `[product-search] combined "${params.query}" (${country}): ${ranked.candidateCount} candidates -> ${ranked.picks.length} picks ` +
      `(exactMatch=${ranked.isExactMatch}, lazadaPending=${stillPending})`
  );

  return {
    query: params.query,
    country,
    candidateCount: ranked.candidateCount,
    picks: ranked.picks,
    isExactMatch: ranked.isExactMatch,
    pendingLazada: stillPending && lazadaHandle ? lazadaHandle : undefined,
  };
}

/** Direct title lookup — for when the shopper names a specific product that isn't (or
 *  is no longer) part of the currently active search results, mirroring Agoda's
 *  findHotelPickByName. */
export function findProductPickByName(params: {
  nameQuery: string;
  country: string;
  merchants?: string[];
}): ProductPick | null {
  if (!isProductsDbAvailable()) return null;
  const rows = searchProductsByTitle({ nameQuery: params.nameQuery, country: params.country, merchants: params.merchants, limit: 5 });
  if (rows.length === 0) {
    console.log(`[product-search] no DB match for "${params.nameQuery}" in ${params.country}`);
    return null;
  }
  const best = rows[0];
  console.log(`[product-search] resolved "${params.nameQuery}" -> ${best.title} (${best.merchant}:${best.product_id})`);
  return toPick(best, "You chose this one.");
}
