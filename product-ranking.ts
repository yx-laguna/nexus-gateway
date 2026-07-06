/**
 * product-ranking.ts
 *
 * Merchant/platform-agnostic scoring, filtering and relevance utilities shared by
 * every retail product source we combine into one shopper-facing shortlist: the
 * local Shopee/iHerb datafeed (product-db.ts), live Lazada search
 * (lazada-search.ts), and live Shopee search (shopee-live-search.ts, commit-time
 * price-check only). Nothing in this file talks to a network or a database — it's
 * pure functions over the common RankableCandidate shape, so product-search.ts and
 * shopee-price-check.ts can pool candidates from different sources and treat them
 * identically from here on.
 *
 * Scoring formula decided 2026-07-06 (see project memory "Charted Sea live search
 * eval"): rating * log(reviewCount + 2) * trustMultiplier, applied only AFTER hard
 * filters (ads/out-of-stock/budget/minimum-review-floor) run. This mirrors the
 * pre-existing local-only heuristic in the old searchLocalProducts (rating *
 * log(sold_count+2) * official/preferred trust boost) — same shape, kept
 * consistent rather than inventing a second formula, just generalized to use a
 * real review count where a source actually has one.
 */

export interface RankableCandidate {
  source: "shopee_datafeed" | "iherb_datafeed" | "lazada_live" | "shopee_live";
  // "shopee" | "iherb" | "lazada" — the value stored in ProductPick.merchant and
  // used to build the "merchant:productId" key the rest of agent.ts keys off.
  merchant: string;
  productId: string;
  shopId: string | null;
  title: string;
  category: string | null;
  brand: string | null;
  price: number | null;
  salePrice: number | null;
  currency: string | null;
  rating: number | null;
  // True number-of-ratings when the source actually provides one (Lazada's
  // reviewCount, Shopee's item_rating.rating_count[0] from the live search API).
  // The LOCAL DATAFEED HAS NO SUCH FIELD AT ALL — confirmed 2026-07-06 by reading
  // build-products-db.py/product-refresh.ts: only ever ingested item_rating (avg)
  // and item_sold (sold count) from the source CSV. Always null for "*_datafeed"
  // sources — see scoreCandidate's fallback to soldCount for why this still works.
  reviewCount: number | null;
  soldCount: number | null;
  isOfficial: boolean; // official/preferred shop, LazMall
  isAd: boolean; // sponsored/paid placement — never a quality signal, filtered out before scoring
  inStock: boolean;
  productUrl: string;
  imageUrl: string | null;
}

// Below this many ratings, a rating average is too noisy to trust (a 5.0 from 2
// reviews shouldn't outrank a 4.8 from 2,000) — but ONLY enforced when a source
// actually reports a review count at all (see applyHardFilters).
const MIN_REVIEW_FLOOR = 10;

export function scoreCandidate(c: RankableCandidate): number {
  const rating = c.rating ?? 3.5; // unrated items shouldn't zero out entirely
  // Real review count where we have it; the local datafeed's only volume signal
  // (sold_count) as a fallback; 0 (not "unknown treated as popular") if we truly
  // have neither.
  const volume = c.reviewCount ?? c.soldCount ?? 0;
  const trust = c.isOfficial ? 1.2 : 1;
  return rating * Math.log(volume + 2) * trust;
}

export function applyHardFilters(candidates: RankableCandidate[], opts: { budgetMax?: number } = {}): RankableCandidate[] {
  return candidates.filter((c) => {
    if (c.isAd) return false; // paid placement isn't a quality/relevance signal
    if (!c.inStock) return false;
    if (opts.budgetMax != null) {
      const price = c.salePrice ?? c.price;
      // Same null-price leniency as the rest of the codebase — don't drop a
      // candidate blind just because we don't know its price.
      if (price != null && price > opts.budgetMax) return false;
    }
    // Only enforce the floor when a real review count is present — the local
    // datafeed never has one and would otherwise be wiped out entirely.
    if (c.reviewCount != null && c.reviewCount < MIN_REVIEW_FLOOR) return false;
    return true;
  });
}

/** Top-N by score — the bounded pool handed to the LLM ranking step, same division
 *  of labour as the old local-only heuristic pre-sort: cheap/deterministic first,
 *  LLM judgment only over a small, already-good pool. */
export function shortlist(candidates: RankableCandidate[], topN = 20): RankableCandidate[] {
  return [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a)).slice(0, topN);
}

/**
 * True if at least one meaningful (3+ char) query term literally appears in the
 * title — the relevance guard originally built for the local datafeed (a query
 * like "toothbrush" could otherwise match purely via a category/description/brand
 * mention with no real toothbrush in the pool at all — see product-search.ts's
 * history). Applied uniformly across every pooled source now (local datafeed,
 * Lazada, live Shopee) so none of them can sneak an irrelevant result past on a
 * non-title field either.
 */
export function titleMatchesQuery(title: string | null, query: string): boolean {
  if (!title) return false;
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return true;
  const lowerTitle = title.toLowerCase();
  return terms.some((t) => lowerTitle.includes(t));
}
