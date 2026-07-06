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
  // Lazada's own "isAd"/"isSponsored" search-result flags. Originally treated as a
  // hard exclusion filter ("paid placement isn't a quality signal") — REVERSED
  // 2026-07-06 after a real production incident: a live "frying pan" (SG) search
  // came back with isAd=true on ALL 40/40 results, including obviously legitimate,
  // well-reviewed listings (e.g. CAROTE, a real cookware brand, 1000+ reviews,
  // 4.9+ rating). Boosted/sponsored placement is apparently near-universal seller
  // practice on Lazada's search results, not a rare special case — hard-filtering
  // on it was silently wiping out the ENTIRE Lazada pool on every search, leaving
  // only the much thinner local Shopee datafeed to survive into the final picks
  // (which looked, from the outside, like "Lazada isn't being searched at all,"
  // when it was — every one of its results was just being discarded). No longer
  // filtered on at all (see applyHardFilters) — kept here for visibility/future
  // recalibration only. The review-count-weighted scoring formula below is the
  // real quality signal and already naturally deprioritizes weak listings
  // regardless of ad status.
  isAd: boolean;
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
    // isAd is NOT filtered on — see RankableCandidate's comment for the real
    // incident that reversed this (100% of a live Lazada result set came back
    // isAd=true, including clearly legitimate, well-reviewed products).
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

function normalizeWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

/**
 * Word-overlap similarity — robust to punctuation/formatting differences (e.g. a
 * brand separator like "|") that break a naive substring check. Returns the
 * fraction of `reference`'s meaningful (3+ char) words that also appear in
 * `candidate`. Real incident (2026-07-06): the LLM correctly resolved "number 4" to
 * "CAROTE Titanium Non-Stick Frying Pan," but the actual shown pick's title was
 * "CAROTE | Titanium Non-Stick Frying Pan" — the "|" broke a plain
 * title.includes(needle)/needle.includes(title) check even though every real word
 * matched, silently failing to resolve the shopper's choice and falling back to
 * re-showing the whole list. Used both for cross-platform "is this the same item"
 * checks (shopee-price-check.ts) and for resolving a named/described pick against
 * the options actually shown (agent.ts).
 */
export function titleWordOverlap(reference: string, candidate: string): number {
  const refWords = normalizeWords(reference);
  if (refWords.size === 0) return 0;
  const candWords = normalizeWords(candidate);
  let overlap = 0;
  for (const w of refWords) if (candWords.has(w)) overlap++;
  return overlap / refWords.size;
}
