/**
 * shopee-price-check.ts
 *
 * Commit-time-only cross-check: once a shopper has committed to a specific Lazada
 * product (see agent.ts's buildShopeePriceCheckMessage), see whether Shopee has the
 * same item for less, or something close. Decided 2026-07-06 (project memory,
 * "Charted Sea live search eval"): checks the local Shopee datafeed first
 * (product-db.ts — instant, free, but a curated slice with real coverage gaps —
 * e.g. it has ZERO toothpaste listings in SG) and only falls back to the live
 * Charted Sea scraper (shopee-live-search.ts) when the datafeed has nothing
 * title-relevant, since that live call alone can take 2+ minutes.
 *
 * Match strictness matters here specifically because a positive result makes a
 * factual "cheaper" claim: isLikelyExactMatch requires most of the chosen item's
 * meaningful title words to reappear (same brand + variant, not just same
 * category) before calling something an exact match and comparing price. Anything
 * looser is surfaced as "closest options" with NO price-comparison claim, since a
 * 1-pack vs 2-pack (or different flavour/size) isn't an apples-to-apples
 * comparison even when the brand matches.
 */

import { searchProductCandidates, type ProductRow } from "./product-db.js";
import { searchShopeeLive } from "./shopee-live-search.js";
import { titleMatchesQuery, scoreCandidate, type RankableCandidate } from "./product-ranking.js";
import type { ProductPick } from "./product-search.js";

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
 * Word-overlap heuristic — NOT real brand/pack-size parsing, just a conservative
 * first pass. False negatives (missing a real match, so we show it as "closest"
 * instead) are the safe failure mode here; false positives (a wrong "cheaper!"
 * claim) are not, so the bar is deliberately high (60% of the chosen title's
 * meaningful words must reappear).
 */
function isLikelyExactMatch(chosenTitle: string, candidateTitle: string): boolean {
  const chosenWords = normalizeWords(chosenTitle);
  if (chosenWords.size === 0) return false;
  const candWords = normalizeWords(candidateTitle);
  let overlap = 0;
  for (const w of chosenWords) if (candWords.has(w)) overlap++;
  return overlap / chosenWords.size >= 0.6;
}

function formatCandidate(c: { title: string; price: number | null; salePrice: number | null; currency: string | null; productUrl: string }): string {
  const price = c.salePrice ?? c.price;
  const priceStr = price != null ? ` — ${c.currency ?? ""} ${price.toFixed(2)}` : "";
  return `*${c.title}*${priceStr}\n${c.productUrl}`;
}

function datafeedRowToCandidate(r: ProductRow): RankableCandidate {
  return {
    source: "shopee_datafeed",
    merchant: "shopee",
    productId: r.product_id,
    shopId: r.shop_id,
    title: r.title ?? "",
    category: r.category,
    brand: r.brand,
    price: r.price,
    salePrice: r.sale_price,
    currency: r.currency,
    rating: r.rating,
    reviewCount: null, // the local datafeed never carries a true review count — see product-ranking.ts
    soldCount: r.sold_count,
    isOfficial: r.is_official === 1,
    isAd: false,
    inStock: r.stock == null || r.stock > 0,
    productUrl: r.product_url ?? "",
    imageUrl: r.image_url,
  };
}

/**
 * Returns a chat-ready message describing the outcome — always a string (never
 * null), since even "found nothing" deserves an honest reply rather than silence.
 * Throws only on a genuine unexpected error; callers should catch and send their
 * own fallback line in that case (see agent.ts).
 */
export async function checkShopeeAlternative(chosen: ProductPick, country: string): Promise<string> {
  const chosenPrice = chosen.salePrice ?? chosen.price;

  // Tier 1: local datafeed — free, instant. Same title-relevance bar as the main
  // combined search so an unrelated datafeed row can't sneak into the comparison.
  const localRows = searchProductCandidates({
    query: chosen.title,
    country,
    merchants: ["shopee"],
    inStockOnly: true,
    limit: 50,
  }).filter((r) => titleMatchesQuery(r.title, chosen.title));

  let candidates: RankableCandidate[] = localRows.map(datafeedRowToCandidate);
  let usedLiveScrape = false;

  if (candidates.length === 0) {
    usedLiveScrape = true;
    const live = await searchShopeeLive({ query: chosen.title, country, maxWaitMs: 170_000 });
    if (live) candidates = live.filter((c) => titleMatchesQuery(c.title, chosen.title));
  }

  if (candidates.length === 0) {
    return usedLiveScrape
      ? `Checked Shopee for *${chosen.title}* — couldn't find anything matching there right now. The Lazada link above is still your best bet.`
      : `Checked Shopee for *${chosen.title}* — nothing matching in stock right now. The Lazada link above is still your best bet.`;
  }

  const exact = candidates.find((c) => isLikelyExactMatch(chosen.title, c.title));
  if (exact) {
    const exactPrice = exact.salePrice ?? exact.price;
    if (exactPrice != null && chosenPrice != null && exactPrice < chosenPrice) {
      return `Found the same item cheaper on Shopee:\n${formatCandidate(exact)}`;
    }
    return `Also checked Shopee — same item is there too, but the Lazada price above is as good or better:\n${formatCandidate(exact)}`;
  }

  const closest = [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a)).slice(0, 3);
  return (
    `Didn't find an exact match on Shopee, but here are the closest options (not a confirmed price comparison, ` +
    `since these aren't guaranteed to be the exact same item):\n\n` +
    closest.map(formatCandidate).join("\n\n")
  );
}
