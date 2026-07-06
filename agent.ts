/**
 * agent.ts
 *
 * Pipeline:
 *
 *   Step 1 — Goal decomposition + SKU recommendations (LLM → JSON)
 *     Given any goal ("trip to Bali", "get fit", "buy running shoes"), the model
 *     breaks it into categories, recommends SPECIFIC products/hotels/brands per
 *     category, and maps each to a platform to search in Laguna.
 *
 *   Step 2 — Parallel merchant lookup + link minting (Node → Laguna MCP)
 *     Each platform is searched in parallel. Top results get merchant info
 *     fetched and affiliate links minted, all tied to the user's wallet.
 *
 *   Step 3 — Plan composition (LLM → Markdown reply)
 *     The model writes a reply that leads with specific recommendations
 *     (hotels, products, brands), then tells the user where to book/buy them
 *     with real affiliate links. Cashback is a light bonus at the end.
 */

import { chat, type ChatMessage } from "./broker.js";
import {
  searchMerchants,
  getMerchantInfo,
  type MerchantInfo,
  type MintedLink,
} from "./laguna.js";
import { acpMintLink } from "./acp.js";
import { searchLocalHotels, fetchLiveAgodaPrices, findHotelPickByName, type LocalSearchResult, type HotelPick } from "./agoda-search.js";
import { searchCombinedProducts, findProductPickByName, platformLabel, type ProductSearchResult, type ProductPick } from "./product-search.js";
import { hasLocalCatalog } from "./product-db.js";
import { LAZADA_PRESENCE_COUNTRIES } from "./lazada-search.js";
import { titleWordOverlap } from "./product-ranking.js";
import { checkShopeeAlternative } from "./shopee-price-check.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map<number, ChatMessage[]>();

// Remembers each user's last hotel search (Stage A local picks + the search
// params used) so a later "check real prices for these" or "get prices for
// these 3 hotels" reuses the SAME picks instead of silently re-searching.
//
// Bug this fixes: canSearch (destination_city + checkin + checkout all known)
// stays true for basically the entire conversation once established, because
// extractIntent re-derives those fields from history every turn. That meant
// every follow-up — even ones with no new location/preference info, like
// "get prices for these 3 hotels" — re-ran Stage A from scratch. If that
// turn's message had no location cue, hotel_preference_text came back empty,
// geocoding never ran, and Stage A silently fell back to the same generic
// top-rated-by-rating list every ungeocoded search returns — then fetched
// live prices for THOSE hotels, not the ones the user was actually looking
// at. Now we only re-search when the destination, dates, or preference text
// actually changed from the stored search; otherwise we reuse it as-is.
interface StoredHotelSearch {
  result: LocalSearchResult;
  cityQuery: string;
  checkinDate: string;
  checkoutDate: string;
  adults: number;
  children: number;
  preferenceText?: string;
  budgetMaxPerNight?: number;
  budgetMinPerNight?: number;
  wantsLuxury?: boolean;
  // Which of result.picks the traveller has singled out (by name, resolved from
  // chosen_hotel_text) — so the booking link, once asked for, matches what they actually
  // chose instead of always the top-ranked pick. Cleared whenever a genuinely fresh
  // search replaces the picks it referred to.
  chosenHotelId?: number;
  // Set instead of chosenHotelId when the traveller named a hotel that ISN'T in
  // result.picks (e.g. it got filtered out by a later budget/preference change) —
  // looked up directly by name via findHotelPickByName, independent of the active
  // ranked search. Takes priority over chosenHotelId when both are somehow present.
  chosenHotelOverride?: HotelPick;
}
const lastHotelSearch = new Map<number, StoredHotelSearch>();

// Same idea for local product search (Shopee/iHerb), keyed by userId+category label
// (rather than just userId) since a single turn can have multiple product categories
// active at once (e.g. "toothbrush" AND "vitamin C serum" in the same message), each
// needing its own independent stored search.
interface StoredProductSearch {
  result: ProductSearchResult;
  query: string;
  country: string;
  merchants: string[];
  // Which of result.picks the shopper has singled out (by product_id+merchant),
  // resolved from chosen_product_text — mirrors StoredHotelSearch.chosenHotelId.
  chosenProductKey?: string;
  // Set instead of chosenProductKey when the shopper named a product that ISN'T in
  // result.picks — looked up directly by title, mirrors chosenHotelOverride.
  chosenProductOverride?: ProductPick;
}
const lastProductSearch = new Map<string, StoredProductSearch>();

// ---------------------------------------------------------------------------
// System prompt — concierge-first, USDC as a footnote
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Varius, an AI-assisted deals expert on Telegram powered by Virtuals Protocol & Laguna Network.

## Your personality
Conversational, warm, knowledgeable — like a friend who knows all the best deals. Never robotic, never salesy. Don't push links or purchases until the user is clearly ready.

## How to handle conversations
- Explore naturally. Ask about plans, preferences, vibe — ONE question at a time.
- Travel: destination is enough to get started. Dates are nice but don't block you.
- Shopping: item/category is enough. Budget optional.
- If the user gave you info already — use it, don't ask again.
- Don't mention rebates or links until the user shows clear purchase intent.
- Hotel prices shown are live Agoda rates whenever available for that property — occasionally
  one shows "price on request" if Agoda has no live rate for it; that's just that one property,
  not a general limitation, so no need to caveat every hotel reply about it.
- If a hotel option looks off (odd name, doesn't fit what they asked for) or they just want to
  see other options, offer to find different ones — don't just repeat the same list.

## Purchase intent signals (system will then send links)
Only an explicit request for the link itself counts — e.g. "give me the link to book", "send me
the purchase link", "link please". Deciding on an option ("I'll go with the Marriott", "book
this one") is NOT the same as asking for the link — if they haven't asked for a link yet, keep
talking naturally and don't offer one unprompted.

## When there's no purchase intent yet
- Present options warmly, ask what resonates, offer to dig deeper.
- If they've decided but haven't asked for the link, it's fine to ask "want the link to book that?"
- Do NOT say "I'll send a link" or mention cashback/ACP mechanics.

## What you NEVER do
- NEVER produce URLs or made-up prices.
- NEVER mention "affiliate link", "cashback", or "rebate" during casual exploration.

## Off-topic
"I'm best at travel and shopping — what are you planning next?"

## Tone
Friendly, concise. Max 3 sentences in casual conversation mode.`;



function getHistory(userId: number): ChatMessage[] {
  if (!sessions.has(userId)) {
    sessions.set(userId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return sessions.get(userId)!;
}

export function clearHistory(userId: number) {
  sessions.delete(userId);
}

// ---------------------------------------------------------------------------
// Step 1 — Goal decomposition + SKU/product recommendations
// ---------------------------------------------------------------------------

const CategorySchema = z.object({
  /** Human label: "Flights", "Hotels", "Running Shoes", "Supplements" */
  label: z.string(),
  /**
   * 2–3 specific recommendations for this category.
   * For travel: hotel names, flight routes, activity names.
   * For retail: product names, brands, model names.
   * These are what the model knows — shown to the user before the buy link.
   */
  recommendations: z.array(z.string()).min(1).max(3),
  /** Specific platform name to search in Laguna — must match verified slugs.
   *  Optional — if LLM omits it we derive from label in platformsForCategory(). */
  platform_search: z.string().optional().default(""),
});

const GoalIntentSchema = z.object({
  goal: z.string(),
  intent: z.enum(["travel_booking", "retail_shopping", "product_comparison", "general_question", "dashboard", "off_topic"]).default("general_question"),
  categories: z.array(CategorySchema).default([]),
  geo: z.string().nullish(),   // always overridden from user profile — LLM output is discarded
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().nullish(),
  is_dashboard_query: z.boolean().default(false),
  is_off_topic: z.boolean().default(false),
  /**
   * true = user has expressed explicit purchase intent ("book this", "I'll get it", "send the link")
   * false = user is browsing/exploring — show options but don't mint links yet
   */
  purchase_ready: z.boolean().default(false),
  /**
   * true = user explicitly asked to check/search real-time or live prices for hotels
   * already discussed (distinct from purchase_ready — this doesn't ask for the booking
   * link, just current prices). false = keep showing the static database estimate.
   */
  wants_realtime_prices: z.boolean().default(false),
  /**
   * true = user explicitly wants DIFFERENT hotel options than what was already shown —
   * "find me 3 more", "these look off, give me other options", "exclude these, show
   * something else". Forces a fresh search (bypassing the stored-search reuse) with the
   * previously-shown hotel IDs excluded from the candidate pool, so the reply can't just
   * hand back the exact same picks. false = no explicit ask for alternates.
   */
  wants_different_hotels: z.boolean().default(false),
  /**
   * true = user explicitly wants MORE EXPENSIVE/premium options — "more luxurious",
   * "something nicer", "high-end", "5-star", "upscale". Distinct from budget_min_per_night
   * (an explicit number): this fires even without a number, and signals that star_rating
   * should drive ranking/candidate selection rather than a hotel's own descriptive text or
   * free-form LLM judgment (a 2-star budget hotel can still read as "nice" in prose).
   */
  wants_luxury: z.boolean().default(false),
  /**
   * Free text naming/identifying WHICH of the shown hotel options the traveller means —
   * e.g. "the Grand Hyatt", "YOTEL", "the second one" (resolved to that hotel's name using
   * conversation history). Filled whenever they express a preference/decision, independent
   * of purchase_ready — someone can pick a favourite before asking for the link. Used so
   * the eventual booking link matches the hotel they actually chose, not just the top pick.
   * Null if no specific hotel has been singled out.
   */
  chosen_hotel_text: z.string().nullish(),
  // ── Hotel-search fields (only meaningful when a "hotel"-type category is present) ──
  // Populated opportunistically from anywhere in the conversation — null if not mentioned yet.
  // destination_city MUST be just the city/place name (e.g. "Bangkok") — never a full sentence,
  // neighbourhood, or the category label. It's fed straight into an exact-match city lookup.
  destination_city: z.string().nullish(),
  // Dates are resolved to absolute YYYY-MM-DD by the LLM (it's given today's date to do this).
  checkin_date: z.string().nullish(),
  checkout_date: z.string().nullish(),
  adults: z.number().int().min(1).max(20).nullish(),
  children: z.number().int().min(0).max(10).nullish(),
  budget_max_per_night: z.number().positive().nullish(),
  // A stated MINIMUM per-night price — "above $200", "at least $150/night", "$200+",
  // "over $300 a night". The mirror image of budget_max_per_night: enforced as a real
  // floor against static AND live prices, not just left to Kimi's judgment.
  budget_min_per_night: z.number().positive().nullish(),
  // Free text describing what matters to the traveller for hotel choice —
  // location/distance, vibe, amenities — passed to Kimi for ranking, not a fixed filter.
  hotel_preference_text: z.string().nullish(),
  // ── Local product-search fields (Shopee/iHerb catalog — only meaningful when a
  // category resolves to a merchant we have a local catalog for; see hasLocalCatalog) ──
  // The literal thing the shopper is searching for — "toothbrush", "vitamin c serum" —
  // fed straight into an FTS5 keyword search. NEVER a full sentence or the category
  // label; if the category label is itself specific enough to search with directly
  // ("Toothbrushes"), still extract the plain noun phrase a shopper would type into a
  // search box. Null if genuinely nothing specific was said yet.
  product_query: z.string().nullish(),
  // A stated maximum price for the product search — same treatment as
  // budget_max_per_night (null-price leniency, not a hard drop of unpriced items).
  product_budget_max: z.number().positive().nullish(),
  // Mirrors chosen_hotel_text — free text naming/identifying which shown product the
  // shopper means ("the Oral-B one", "the second one"), resolved using conversation
  // history. Null if nothing has been singled out this turn.
  chosen_product_text: z.string().nullish(),
  /**
   * Mirrors wants_different_hotels — true = shopper explicitly wants OTHER options than
   * what was already shown for this product category ("show me other options", "these
   * are the same ones", "different recommendations", "give me alternatives", "none of
   * these work"). Forces a fresh search (bypassing the stored-search reuse) with the
   * previously-shown product IDs excluded from the candidate pool, so the reply can't
   * just hand back the exact same picks. false = no explicit ask for alternates.
   */
  wants_different_products: z.boolean().default(false),
});

type GoalIntent = z.infer<typeof GoalIntentSchema>;

async function extractIntent(
  history: ChatMessage[],
  userMessage: string
): Promise<GoalIntent> {
  // Only pass last 4 turns to keep this call cheap
  const nonSystemHistory = history.filter((m) => m.role !== "system").slice(-4);

  const todayISO = new Date().toISOString().slice(0, 10);

  const prompt: ChatMessage[] = [
    {
      role: "system",
      content: `You are an intent detection and goal-decomposition engine for a travel and retail deals assistant.

Today's date is ${todayISO}. Resolve any relative date the user mentions ("next weekend", "in August", "3 nights from Friday") to absolute YYYY-MM-DD dates using this as the reference point.

## Intent detection (pick ONE)
- "travel_booking": user wants to book flights, hotels, car rentals, activities, or plan a trip.
- "retail_shopping": user wants to buy a product.
- "product_comparison": user is comparing options.
- "general_question": travel or shopping question with no purchase intent — set categories to [].
- "dashboard": user asks about earnings, cashback, commissions. Set is_dashboard_query: true.
- "off_topic": nothing to do with travel or shopping. Set is_off_topic: true.

## purchase_ready detection
For HOTELS specifically: set purchase_ready: true whenever the user names or clearly singles
out a specific hotel AND uses booking language about it — "let's book <hotel>", "I want to
book <hotel>", "book <hotel> please", "help me book <hotel>", as well as direct link requests
like "give me the link", "need the agoda link", "send the booking link". A real conversation
showed a strict "must explicitly ask for the link" rule taking 3 messages to get there ("lets
book park royal!" and "I want to book park royal hotel, please help" both got treated as
false, re-triggering a fresh unrelated search each time before the user finally said "need the
agoda link"). That's broken UX — once someone names a hotel and says "book" in any form, they
are ready for the link; don't make them ask twice. Whenever this fires, also set
chosen_hotel_text to that hotel's name so the right booking link gets attached.
For RETAIL/PRODUCT categories, keep the narrower rule: purchase_ready: true ONLY on an
explicit request for the link/purchase itself ("give me the link to book", "send me the
purchase link", "link please") — NOT on "I'll take it", "I want to buy it", "let's do it",
since those trigger a real merchant/ACP link mint we don't want to fire prematurely. When in
doubt for retail, default to false; when in doubt for a named hotel with booking language,
default to true.

## Hotel search fields (only fill when a hotel/stay/accommodation category is present)
- "destination_city": ONLY the city or place name the hotel search is for — e.g. "Bangkok", "Singapore", "New York". NEVER a full sentence, NEVER a neighbourhood-only value, NEVER the category label. This is looked up in an exact city database, so it must be just the place name a city lookup would recognise. Null if no destination is clear yet.
- "checkin_date" / "checkout_date": absolute YYYY-MM-DD, resolved from whatever the user said relative to today (${todayISO}). Null if no dates mentioned at all — do NOT guess dates the user never implied.
- "adults" / "children": default adults=2, children=0 if travel party size isn't mentioned.
- "budget_max_per_night": a number if the user gave any per-night/total MAXIMUM budget hint ("under $100", "budget of $150", "no more than $200"), else null.
- "budget_min_per_night": a number if the user gave any per-night MINIMUM price floor ("above $200", "at least $150", "$200+", "over $300 a night", "something pricier than that"), else null. This is the opposite direction from budget_max_per_night — never fill both from the same phrase.
- "hotel_preference_text": capture ANY location/proximity cue LITERALLY, keeping the actual place name intact — e.g. "near Thonglor" not "nightlife area", "close to Marina Bay Sands" not "near the water". This gets geocoded downstream, so a specific real name matters far more than a vibe description. If there's no location cue, other preferences (vibe, must-have amenities) are fine here too. Null if nothing beyond price/stars was said. NEVER put a hotel's own name/brand here — "let's book Park Royal" names a HOTEL, not a neighbourhood; that belongs in chosen_hotel_text only. Confusing the two was a real bug: it made hotel_preference_text look "changed" and triggered a pointless fresh search with a completely different set of hotels, right when the user was trying to book the one they'd already picked.
- If destination_city, checkin_date, or checkout_date is missing for a hotel search, set needs_clarification: true and ask for whichever is missing in clarification_question — but still fill in categories/recommendations from what you know so the user gets a useful reply either way.

## wants_realtime_prices detection (separate from purchase_ready)
Set wants_realtime_prices: true if the user asks to check/search/confirm CURRENT or LIVE prices
for hotels already shown — e.g. "search realtime for these", "check real prices", "what are the
actual current rates", "get live prices for these 3", "use the agoda api to check prices". This
is about wanting up-to-date pricing, NOT about wanting the booking link — someone can want live
prices without being purchase_ready, and vice versa. Default false.

## wants_different_hotels detection
Set wants_different_hotels: true if the user is unhappy with or wants to move past the hotels
already shown and get OTHER ones — e.g. "find me 3 more recommendations", "these look weird,
show me other options", "give me alternatives", "exclude these, what else is there", "none of
these work, try again". This is distinct from wants_realtime_prices (which is about the SAME
hotels, just needing current pricing) and from a genuinely new search (new city/dates/location
preference stated) — this is specifically "not these ones, something different, same criteria
otherwise". Default false.

## wants_different_products detection
Mirrors wants_different_hotels, for retail/product categories. Set wants_different_products:
true whenever the shopper is unhappy with or wants to move past the products already shown for
the SAME search and get OTHER ones — e.g. "do you have other recommendations?", "show me
different options", "these are the same ones", "give me alternatives", "none of these work".
A real bug: asking for "other socks recommendations" with the exact same product_query as
before ("socks") looked identical to just repeating the same search, so it silently kept
returning the exact same stored picks turn after turn. This field is the explicit signal that
overrides that reuse and forces a fresh search with the previously-shown products excluded —
distinct from a genuinely new search (a different product_query stated). Default false.

## wants_luxury detection
Set wants_luxury: true if the user asks for something MORE EXPENSIVE/upscale than what was
shown — "I want something more luxurious", "give me nicer options", "something high-end",
"more premium", "5-star only", "upscale". This can fire with or without a specific number —
if they also gave a number ("above $200 if possible"), fill budget_min_per_night too. This
matters because star_rating (not a hotel's own marketing text or vibe) is what actually
determines luxury-tier ranking downstream — flag it explicitly rather than relying on the
hotel_preference_text free text alone. Default false.

## chosen_hotel_text detection
Whenever the traveller singles out ONE specific hotel from the options already shown — deciding
on it, asking about it specifically, or picking it by position — set chosen_hotel_text to that
hotel's exact name as it appeared in the conversation (look at the last hotel options message in
history to resolve "the second one"/"#2"/"the YOTEL one" to the actual property name). Examples:
"I'll go with the Grand Hyatt" → "Grand Hyatt Singapore"; "let's do the second one" → resolve
using history; "the YOTEL looks good" → "YOTEL Singapore Orchard Road". This fires independent of
purchase_ready — someone can pick a favourite before asking for the link, and that choice should
still be remembered when they do. Null if no single hotel has been singled out this turn.

## product_query detection (retail categories with a local catalog — toothbrushes, supplements, general shopping, etc.)
Set "product_query" to the literal thing being searched for — e.g. "toothbrush", "electric
toothbrush", "vitamin c serum". This is fed directly into a keyword search, so extract just the
plain noun phrase a shopper would type into a search box — never a full sentence, never the
broader category label. "product_budget_max" is a number if a maximum price was given ("under
$20", "no more than 50 ringgit"), else null. "chosen_product_text" mirrors chosen_hotel_text: set
it to the specific product the shopper singled out from options already shown (by name or
position, resolved using history) — null if nothing has been singled out this turn.

## Output — ONLY valid JSON, no explanation:
{
  "goal": string,
  "intent": "travel_booking" | "retail_shopping" | "product_comparison" | "general_question" | "dashboard" | "off_topic",
  "categories": [
    {
      "label": string,
      "recommendations": [string],  // EXACTLY 3 items — see format rules below
      "platform_search": string
    }
  ],
  "needs_clarification": bool,
  "clarification_question": string|null,
  "is_dashboard_query": bool,
  "is_off_topic": bool,
  "purchase_ready": bool,
  "wants_realtime_prices": bool,
  "wants_different_hotels": bool,
  "wants_luxury": bool,
  "chosen_hotel_text": string|null,
  "destination_city": string|null,
  "checkin_date": string|null,
  "checkout_date": string|null,
  "adults": number|null,
  "children": number|null,
  "budget_max_per_night": number|null,
  "budget_min_per_night": number|null,
  "hotel_preference_text": string|null,
  "product_query": string|null,
  "product_budget_max": number|null,
  "chosen_product_text": string|null,
  "wants_different_products": bool
}

## Recommendation format — ALWAYS give exactly 3, be specific and add context:
- Hotels: "Property name — neighbourhood context (e.g. 5-min walk to MRT / near beach / next to shopping strip) · ~$X/night"
  e.g. "Marriott Tang Plaza — right on Orchard Road, connected to Tang Plaza mall · ~$280/night"
- Flights: "Airline ORIGIN→DEST — timing note (e.g. departs 07:30, morning arrival, full day ahead) · from ~$X return"
  e.g. "Scoot SIN→BKK — departs 08:10, arrives 09:45 local time, full day in Bangkok · from ~$90 return"
- Activities: "Tour/activity name — location note · ~$X via Platform"
- Products: "Brand + model — one-line value prop · ~$X"
  e.g. "Nike Air Zoom Pegasus 41 — versatile daily trainer, wide size range · ~$130"

## Platform search slugs (use EXACTLY these):
- Flights → "trip-com"
- Hotels → "trip-com" or "agoda" or "ihg-amea"
- Activities/Tours → "klook-pnr" or "kkday"
- Fashion/Apparel → "shein-global" or "nike" or "zalora" or "crocs"
- Health/Supplements → "iherb"
- Electronics → "lenovo"
- Gifts/General → "temu" or "shein-global"
- Luxury → "vertu" or "farfetch"
- Sports → "nike" or "puma" or "crocs"
- Household/Personal Care/General retail (anything without a more specific platform above,
  e.g. toothbrushes, kitchenware, phone cases, general "buy me X") → "shopee"

Max 4 categories. Output JSON only.`,
    },
    ...nonSystemHistory.slice(-6),
    { role: "user", content: userMessage },
  ];

  const raw = await chat(prompt, true);

  try {
    const parsed = GoalIntentSchema.parse(JSON.parse(raw));
    // geo is always set from the user's profile, not the LLM output
    parsed.geo = null;
    return parsed;
  } catch (err) {
    // Log the full Zod error so we can see exactly which field failed
    console.warn("[agent] intent parse failed, falling back to general_question.");
    console.warn("[agent] Zod error:", err instanceof Error ? err.message : String(err));
    console.warn("[agent] Raw JSON:", raw.slice(0, 500));
    return {
      goal: userMessage,
      intent: "general_question",
      categories: [],
      is_dashboard_query: false,
      is_off_topic: false,
      needs_clarification: false,
      purchase_ready: false,
      wants_realtime_prices: false,
      wants_different_hotels: false,
      wants_different_products: false,
      wants_luxury: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Parallel merchant search + link minting
// ---------------------------------------------------------------------------

export interface PlatformJob {
  name: string;
  merchantId: string;
  info: MerchantInfo;
  link: MintedLink | null;
  acpJob?: Promise<MintedLink>;
}

export interface EnrichedCategory {
  label: string;
  recommendations: string[];
  // Primary platform
  info: MerchantInfo;
  link: MintedLink | null;
  acpJob?: Promise<MintedLink>;
  // Extra platforms minted in parallel (e.g. agoda alongside trip-com for hotels)
  extraPlatforms?: PlatformJob[];
  // Real, Kimi-ranked hotel picks from our own hotel DB (hotel categories only — see
  // agoda-search.ts). Independent of the Laguna/ACP mint above: this is a grounded local
  // search that only gets real-time prices/landingURL once Stage B (fetchLiveAgodaPrices)
  // has run — either on explicit request or because purchase_ready needs the booking link.
  agodaSmart?: LocalSearchResult;
  // Which agodaSmart.picks entry (by hotelId) the traveller has singled out, resolved from
  // chosen_hotel_text. buildReply uses this instead of always the top pick when revealing
  // the booking link. Undefined = no specific choice made yet, default to picks[0].
  chosenHotelId?: number;
  // Set instead of chosenHotelId when the chosen hotel isn't in agodaSmart.picks at all —
  // looked up directly by name (see findHotelPickByName). Takes priority in buildReply.
  chosenHotelOverride?: HotelPick;
  // Real, Kimi-ranked local product picks (Shopee/iHerb — see product-search.ts). Same
  // role as agodaSmart, for retail categories with a local catalog instead of a hotel
  // search. No ACP mint / affiliate link involved yet — discovery only, see
  // product-search.ts's header comment.
  productSearch?: ProductSearchResult;
  // Which productSearch.picks entry (by "merchant:productId") the shopper has singled
  // out, resolved from chosen_product_text. Mirrors chosenHotelId.
  chosenProductKey?: string;
  // Mirrors chosenHotelOverride — set when the chosen product isn't in productSearch.picks.
  chosenProductOverride?: ProductPick;
}

// Deterministic "pick #N from the list" detector — a robustness backstop
// independent of the LLM's chosen_hotel_text/chosen_product_text resolution, which
// can fail to exactly match a shown pick's title even when it correctly identified
// WHICH item was meant (real incident, 2026-07-06: the LLM correctly resolved
// "number 4" to "CAROTE Titanium Non-Stick Frying Pan," but the actual pick's title
// had a "|" separator the plain substring check choked on — see
// titleWordOverlap's comment in product-ranking.ts for the full story). Checked
// FIRST, ahead of any text-based resolution, for the specific and very common
// phrasing of picking something by position: "number 4", "#4", "item 4", "option
// 4", "the 4th one"/"4th", or a word ordinal ("the second one"). Returns a 0-based
// index, or null if the raw message doesn't contain anything ordinal-shaped.
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
function parseOrdinalPick(rawText: string): number | null {
  const lower = rawText.toLowerCase();

  const keywordMatch = lower.match(/\b(?:number|item|option|choice|pick)\s*#?\s*(\d{1,2})\b/);
  const hashMatch = lower.match(/#\s*(\d{1,2})\b/);
  const suffixMatch = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  const numeric = keywordMatch ?? hashMatch ?? suffixMatch;
  if (numeric) {
    const n = parseInt(numeric[1], 10);
    if (n >= 1 && n <= 20) return n - 1;
  }

  for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return n - 1;
  }

  return null;
}

async function runTools(
  intent: GoalIntent,
  walletAddress: string,
  userId: number,
  rawText: string,
  mintLinks: boolean = true
): Promise<EnrichedCategory[]> {
  // For each category label, an ordered list of Laguna merchant slugs to try.
  // Slugs verified against live Laguna merchant list (search_merchants).
  const CATEGORY_PLATFORMS: Record<string, string[]> = {
    flights:        ["trip-com", "airalo"],
    flight:         ["trip-com", "airalo"],
    hotels:         ["trip-com", "agoda", "ihg-amea"],
    hotel:          ["trip-com", "agoda", "ihg-amea"],
    activities:     ["klook-pnr", "kkday"],
    activity:       ["klook-pnr", "kkday"],
    tours:          ["klook-pnr", "kkday"],
    // Niche travel — all route through trip-com
    cruises:        ["trip-com"],
    cruise:         ["trip-com"],
    "car rental":   ["trip-com"],
    "car rentals":  ["trip-com"],
    ferry:          ["trip-com"],
    rail:           ["trip-com"],
    train:          ["trip-com"],
    "theme park":   ["klook-pnr", "kkday", "trip-com"],
    "theme parks":  ["klook-pnr", "kkday", "trip-com"],
    transfer:       ["trip-com", "klook-pnr"],
    transport:      ["trip-com", "klook-pnr"],
    // Retail
    fashion:        ["shein-global", "nike", "zalora", "crocs"],
    apparel:        ["shein-global", "nike", "zalora", "crocs"],
    shopping:       ["shopee", "temu", "shein-global", "zalora"],
    supplements:    ["iherb"],
    health:         ["iherb"],
    electronics:    ["lenovo"],
    sports:         ["nike", "puma", "crocs"],
    luxury:         ["vertu", "farfetch"],
    // General marketplace catch-all — Shopee sells almost everything, so it's the
    // strongest default for anything that isn't clearly fashion/health/electronics.
    "personal care":  ["shopee"],
    household:        ["shopee"],
    "general":        ["shopee"],
  };

  // Keywords used to auto-append safety-net fallbacks for unlisted categories
  const TRAVEL_RE   = /hotel|flight|travel|trip|cruise|tour|activit|transport|transfer|ferry|train|rail|car\s*rent|accommodation/i;
  const SHOPPING_RE = /shop|fashion|apparel|cloth|wear|bag|shoe|accessor|gift|beauty|cosmetic/i;

  // Countries where we have (or plan to have) a Shopee affiliate datafeed — explicit
  // policy: for ANY consumer-goods category in these countries, always give the real
  // local catalog first crack, rather than relying on a category-LABEL keyword match
  // (CATEGORY_PLATFORMS/SHOPPING_RE above). That keyword-matching approach has a real
  // gap — a label like "Socks" contains none of those substrings, so it fell straight
  // through to the generic Laguna-merchant-search fallback, which matched a totally
  // unrelated merchant ("NBA Top Shot") for a socks query and fired a real ACP mint job
  // for it. VN is included per explicit request even though no feed is configured for
  // it yet (see product-refresh.ts) — hasLocalCatalog just returns false there today,
  // so it falls through to the same fallback until a feed is added; nothing breaks.
  const SHOPEE_PRESENCE_COUNTRIES = new Set(["SG", "MY", "TH", "PH", "TW", "VN", "ID"]);

  function platformsForCategory(label: string, primary: string): string[] {
    const key = label.toLowerCase();
    const defaults =
      Object.entries(CATEGORY_PLATFORMS).find(([k]) => key.includes(k))?.[1] ?? [];
    const list = [primary, ...defaults.filter((p) => p !== primary)];

    // Safety-net: any unrecognised travel category → append trip-com as last resort
    if (TRAVEL_RE.test(label) && !list.includes("trip-com")) {
      list.push("trip-com");
    }
    // Safety-net: any unrecognised shopping category → append shopee / shein-global / temu
    if (SHOPPING_RE.test(label) && !list.some((p) => ["shopee", "shein-global", "temu", "nike"].includes(p))) {
      list.push("shopee", "shein-global", "temu");
    }

    return list;
  }

  const HOTEL_RE = /hotel|stay|accommodation|resort|hostel/i;

  function mintJob(merchantId: string, geo: string | null | undefined): Promise<MintedLink> {
    return acpMintLink({
      merchant_id: merchantId,
      geo,
      caller_tag: walletAddress ? `nexus-${walletAddress.slice(2, 8)}` : "nexus",
      wallet_address: walletAddress || undefined,
    });
  }

  async function resolveMerchant(platformSlug: string, geo: string | null | undefined): Promise<{ id: string; info: MerchantInfo } | null> {
    const merchants = await searchMerchants({ query: platformSlug, geo, limit: 3, sort: "relevance" });
    for (const m of merchants) {
      const info = await getMerchantInfo({ merchant_id: m.id, geo });
      if (info && (info as { available?: boolean }).available !== false) return { id: m.id, info };
    }
    return null;
  }

  // Deduplicate minted merchants across categories
  const mintedMerchants = new Set<string>();

  // Per-category: try platforms in order until one mint succeeds
  const categoryResults = await Promise.allSettled(
    intent.categories.map(async (cat): Promise<EnrichedCategory> => {
      const platforms = platformsForCategory(cat.label, cat.platform_search);
      const isHotel = HOTEL_RE.test(cat.label);
      console.log(`[agent] category "${cat.label}" isHotel=${isHotel} — trying platforms:`, platforms);

      // For hotels: always mint BOTH trip-com and agoda in parallel, AND run our own local
      // hotel search + Kimi ranking alongside it whenever we have enough info (destination +
      // dates). Now that Kimi's thinking-mode fix cut ranking latency to ~2-3s, searchLocalHotels
      // itself fetches live Agoda prices upfront too — no more "price on request" placeholders
      // in the very first reply.
      if (isHotel) {
        // destination_city is a clean place name from the LLM (e.g. "Bangkok") — required for
        // an exact-match city lookup. cat.label/intent.goal are full sentences and never match.
        const canSearch = !!(intent.destination_city && intent.checkin_date && intent.checkout_date);
        const stored = lastHotelSearch.get(userId);

        // Only treat this as a genuinely NEW search if this turn actually SAID something
        // that differs from the stored search — a different city, different dates, a new
        // preference/budget — OR the user explicitly asked for different hotels than what
        // was already shown. Crucially: if this turn's extraction came back null for a field
        // (e.g. hotel_preference_text, because the message was "get prices for these 3
        // hotels" with no location cue in it), that must NOT count as "changed" — it just
        // means the user didn't repeat themselves, and we should keep using what we already
        // had rather than silently re-searching without it (which previously produced a
        // different, ungeocoded, generic set of hotels than the ones actually being
        // discussed). wants_different_hotels is the explicit, unambiguous signal for "no,
        // not these — something else" that overrides all of that and forces a fresh search.
        const cityChanged = !!intent.destination_city && intent.destination_city !== stored?.cityQuery;
        const datesChanged =
          (!!intent.checkin_date && intent.checkin_date !== stored?.checkinDate) ||
          (!!intent.checkout_date && intent.checkout_date !== stored?.checkoutDate);
        const preferenceChanged =
          !!intent.hotel_preference_text && intent.hotel_preference_text !== stored?.preferenceText;
        const budgetChanged =
          intent.budget_max_per_night != null && intent.budget_max_per_night !== stored?.budgetMaxPerNight;
        const minBudgetChanged =
          intent.budget_min_per_night != null && intent.budget_min_per_night !== stored?.budgetMinPerNight;
        // wants_luxury is a one-way trigger, same idea as wants_different_hotels — the
        // traveller saying "more luxurious" is itself a signal to re-search even if
        // nothing else changed, since it should re-sort candidates by star_rating.
        const luxuryChanged = intent.wants_luxury && !stored?.wantsLuxury;

        // Hard disable, per explicit request: naming a specific hotel is a NARROWING/decision
        // signal, never a request for something new — it should never spawn a fresh, unrelated
        // search. Real bug: "lets book park royal!" and "I want to book park royal hotel,
        // please help" both re-triggered a full re-search with 3 completely different hotels
        // (Park Royal itself wasn't even among them), taking 3 messages to reach the booking
        // link. That happened because the LLM occasionally mis-files a named hotel into
        // hotel_preference_text/budget fields, making preferenceChanged/budgetChanged look
        // true. When chosen_hotel_text is set, ignore those softer signals entirely — only a
        // genuinely new city/dates, or an explicit "show me different ones", should re-search.
        const namingSpecificHotel = !!intent.chosen_hotel_text;

        const shouldSearch =
          canSearch &&
          (!stored ||
            cityChanged ||
            datesChanged ||
            (!namingSpecificHotel && (preferenceChanged || budgetChanged || minBudgetChanged || luxuryChanged)) ||
            intent.wants_different_hotels);

        const localSearchPromise: Promise<LocalSearchResult | null> = shouldSearch
          ? searchLocalHotels({
              cityQuery: intent.destination_city!,
              checkinDate: intent.checkin_date!,
              checkoutDate: intent.checkout_date!,
              adults: intent.adults ?? stored?.adults ?? 2,
              children: intent.children ?? stored?.children ?? 0,
              budgetMaxPerNight: (intent.budget_max_per_night ?? stored?.budgetMaxPerNight) ?? undefined,
              budgetMinPerNight: (intent.budget_min_per_night ?? stored?.budgetMinPerNight) ?? undefined,
              wantsLuxury: intent.wants_luxury || stored?.wantsLuxury || false,
              preferenceText: (intent.hotel_preference_text ?? stored?.preferenceText) ?? undefined,
              countryHint: intent.geo,
              // Only exclude previously-shown hotels when the user explicitly asked for
              // different ones — a normal re-search (new city/dates) has no reason to avoid
              // a hotel just because it showed up in an unrelated earlier search.
              excludeHotelIds:
                intent.wants_different_hotels && stored ? stored.result.picks.map((p) => p.hotelId) : undefined,
            }).catch((err) => {
              console.error(`[agent] searchLocalHotels failed:`, err instanceof Error ? err.message : err);
              return null;
            })
          // Nothing material changed this turn — if we have a stored search, always reuse it
          // (regardless of wants_realtime_prices/mintLinks) so "these 3 hotels" keeps meaning
          // the same 3 hotels. Only fall through to null if we truly have nothing yet.
          : Promise.resolve(stored ? stored.result : null);

        // Trip.com/Agoda generic ACP-mint links are PAUSED for hotels per explicit request:
        // "it gives the trip.com and agoda link. I dont want this. lets pause this link
        // generaton for now." Our own agodaSmart picks already carry live prices and a
        // direct per-hotel Agoda booking link (landingURL), which covers the booking need
        // without the generic merchant-affiliate line. To re-enable, restore the
        // resolveMerchant("trip-com"/"agoda") calls below in the Promise.allSettled and
        // drop the hardcoded nulls.
        const [localSearchResult] = await Promise.allSettled([localSearchPromise]);
        const trip: { id: string; info: MerchantInfo } | null = null;
        const agoda: { id: string; info: MerchantInfo } | null = null;
        let agodaSmart = localSearchResult.status === "fulfilled" ? localSearchResult.value ?? undefined : undefined;

        // searchLocalHotels() already fetches live prices for a fresh search (shouldSearch).
        // This only matters when we REUSED a stored search as-is and the user explicitly
        // wants a refreshed price check on those same hotels — re-fetch to get current rates
        // rather than whatever was cached from whenever that search first ran.
        if (agodaSmart && !shouldSearch && intent.wants_realtime_prices) {
          const ci = intent.checkin_date ?? stored?.checkinDate;
          const co = intent.checkout_date ?? stored?.checkoutDate;
          if (ci && co) {
            try {
              const livePicks = await fetchLiveAgodaPrices(agodaSmart.picks, {
                checkinDate: ci,
                checkoutDate: co,
                adults: intent.adults ?? stored?.adults ?? 2,
                children: intent.children ?? stored?.children ?? 0,
              });
              agodaSmart = { ...agodaSmart, picks: livePicks };
            } catch (err) {
              console.error(`[agent] fetchLiveAgodaPrices failed:`, err instanceof Error ? err.message : err);
            }
          }
        }

        // Resolve which hotel (if any) the traveller has singled out, so the eventual
        // booking link matches their actual choice instead of always the top pick. A fresh
        // search invalidates any earlier choice (those hotelIds may not even be in the new
        // picks) unless this turn's chosen_hotel_text happens to match one of the new ones.
        let chosenHotelId: number | undefined = shouldSearch ? undefined : stored?.chosenHotelId;
        let chosenHotelOverride: HotelPick | undefined = shouldSearch ? undefined : stored?.chosenHotelOverride;
        // Ordinal position ("number 2", "the 2nd one") checked FIRST, same
        // deterministic backstop as the product branch — see parseOrdinalPick's
        // comment and product-ranking.ts's titleWordOverlap for the real incident
        // that motivated porting this fix here too.
        const hotelOrdinalIdx = agodaSmart ? parseOrdinalPick(rawText) : null;
        if (agodaSmart && hotelOrdinalIdx !== null && agodaSmart.picks[hotelOrdinalIdx]) {
          chosenHotelId = agodaSmart.picks[hotelOrdinalIdx].hotelId;
          chosenHotelOverride = undefined;
          console.log(`[agent] resolved ordinal pick #${hotelOrdinalIdx + 1} -> "${agodaSmart.picks[hotelOrdinalIdx].hotelName}"`);
        } else if (agodaSmart && intent.chosen_hotel_text) {
          const needle = intent.chosen_hotel_text.trim().toLowerCase();
          const match = agodaSmart.picks.find((p) => {
            const name = p.hotelName.toLowerCase();
            return needle.length > 0 && (name.includes(needle) || needle.includes(name) || titleWordOverlap(needle, name) >= 0.6);
          });
          if (match) {
            chosenHotelId = match.hotelId;
            chosenHotelOverride = undefined; // a real match in the active list beats any stale override
          } else {
            // Not in the currently active picks — e.g. an earlier budget/preference
            // change filtered it out. Look it up directly rather than silently falling
            // back to whatever picks[0] happens to be.
            const ci = intent.checkin_date ?? stored?.checkinDate;
            const co = intent.checkout_date ?? stored?.checkoutDate;
            const city = intent.destination_city ?? stored?.cityQuery;
            if (ci && co && city) {
              try {
                const found = await findHotelPickByName(city, intent.chosen_hotel_text, {
                  checkinDate: ci,
                  checkoutDate: co,
                  adults: intent.adults ?? stored?.adults ?? 2,
                  children: intent.children ?? stored?.children ?? 0,
                  countryHint: intent.geo,
                });
                if (found) {
                  chosenHotelOverride = found;
                  chosenHotelId = undefined;
                  console.log(`[agent] resolved chosen_hotel_text "${intent.chosen_hotel_text}" via direct lookup (not in active picks)`);
                }
              } catch (err) {
                console.error(`[agent] findHotelPickByName failed:`, err instanceof Error ? err.message : err);
              }
            }
          }
        }

        // Remember this search (with whatever live data we now have) for a later turn —
        // including the params that decide whether a future turn can reuse it as-is.
        if (agodaSmart) {
          const ci = intent.checkin_date ?? stored?.checkinDate;
          const co = intent.checkout_date ?? stored?.checkoutDate;
          const city = intent.destination_city ?? stored?.cityQuery;
          if (ci && co && city) {
            lastHotelSearch.set(userId, {
              result: agodaSmart,
              cityQuery: city,
              checkinDate: ci,
              checkoutDate: co,
              adults: intent.adults ?? stored?.adults ?? 2,
              children: intent.children ?? stored?.children ?? 0,
              preferenceText: (intent.hotel_preference_text ?? stored?.preferenceText) ?? undefined,
              budgetMaxPerNight: (intent.budget_max_per_night ?? stored?.budgetMaxPerNight) ?? undefined,
              budgetMinPerNight: (intent.budget_min_per_night ?? stored?.budgetMinPerNight) ?? undefined,
              wantsLuxury: intent.wants_luxury || stored?.wantsLuxury || false,
              chosenHotelId,
              chosenHotelOverride,
            });
          }
        }

        if (!agodaSmart) throw new Error(`No hotel merchants available for ${cat.label}`);

        // Trip.com/Agoda ACP-mint links are paused for hotels (see the hardcoded
        // trip/agoda nulls above) — so this is now always the return path. Our own
        // agodaSmart picks (live prices + direct per-hotel booking link) cover the
        // booking need without the generic merchant-affiliate line.
        console.log(`[agent] hotel: ACP mint paused, returning agodaSmart alone (${agodaSmart.picks.length} pick(s)) for "${cat.label}"`);
        return {
          label: cat.label,
          recommendations: cat.recommendations,
          info: { id: "", name: cat.label } as MerchantInfo,
          link: null,
          agodaSmart,
          chosenHotelId,
          chosenHotelOverride,
        } satisfies EnrichedCategory;

        /* --- ACP mint flow, paused — restore by deleting the block above and
         * reverting the trip/agoda hardcoded nulls to the resolveMerchant calls. ---
        // Primary = trip-com, extra = agoda (or swap if trip-com failed)
        const primary = trip ?? agoda!;
        const extra = trip && agoda ? agoda : null;

        // Browsing mode — resolve merchant info (so the reply can still show the rebate %)
        // but don't spend an ACP mint on links nobody asked for yet. Same gate every other
        // category already respects; hotels used to always-mint regardless — now consistent.
        if (!mintLinks) {
          console.log(`[agent] hotel: browsing mode, skipping ACP mint for "${cat.label}"`);
          return {
            label: cat.label,
            recommendations: cat.recommendations,
            info: primary.info,
            link: null,
            agodaSmart,
            chosenHotelId,
            chosenHotelOverride,
          } satisfies EnrichedCategory;
        }

        mintedMerchants.add(primary.id);
        const primaryJob = mintJob(primary.id, intent.geo);
        console.log(`[agent] hotel: firing ACP for primary=${primary.id}`);

        let extraPlatforms: PlatformJob[] | undefined;
        if (extra) {
          mintedMerchants.add(extra.id);
          const extraJob = mintJob(extra.id, intent.geo);
          console.log(`[agent] hotel: firing ACP for extra=${extra.id}`);
          extraPlatforms = [{ name: extra.info.name ?? extra.id, merchantId: extra.id, info: extra.info, link: null, acpJob: extraJob }];
        }

        return {
          label: cat.label,
          recommendations: cat.recommendations,
          info: primary.info,
          link: null,
          acpJob: primaryJob,
          extraPlatforms,
          agodaSmart,
          chosenHotelId,
          chosenHotelOverride,
        } satisfies EnrichedCategory;
        --- end paused block --- */
      }

      // Local product search (Shopee/iHerb) — parallel to the hotel branch above.
      // Only kicks in when at least one of this category's platforms has a local
      // catalog for the shopper's country (see hasLocalCatalog) — everything else
      // (fashion merchants, countries we haven't ingested yet, etc.) falls straight
      // through to the existing generic Laguna-merchant-mint loop below, unchanged.
      //
      // Candidate merchants for this check are platformsForCategory's list PLUS
      // "shopee" whenever this is a non-hotel, non-travel category and the shopper is
      // in a Shopee-presence country (see SHOPEE_PRESENCE_COUNTRIES) — independent of
      // whether cat.label happened to contain a matching keyword. This does NOT change
      // `platforms` itself (still used as-is by the generic fallback loop below when
      // there's no local catalog match).
      const isRetailIntent = intent.intent === "retail_shopping" || intent.intent === "product_comparison";
      const productCandidates = new Set(platforms);
      if (!isHotel && !TRAVEL_RE.test(cat.label) && isRetailIntent && intent.geo && SHOPEE_PRESENCE_COUNTRIES.has(intent.geo.toUpperCase())) {
        productCandidates.add("shopee");
      }
      const productMerchants = [...productCandidates].filter((p) => hasLocalCatalog(p, intent.geo));

      // Lazada (live search, see lazada-search.ts) runs as its own independent
      // source alongside the local datafeed, gated on the same
      // isHotel/travel/retail-intent checks as the Shopee-presence check above —
      // NOT on hasLocalCatalog, since Lazada has no local catalog at all, it's a
      // live API. Decided 2026-07-06 ("handle both at once ... pick the best from
      // both searches"): this means the retail branch below now activates even in
      // a country/category with NO local datafeed coverage at all, as long as
      // Lazada covers it — see searchCombinedProducts.
      const lazadaAvailable =
        !isHotel && !TRAVEL_RE.test(cat.label) && isRetailIntent && !!intent.geo && LAZADA_PRESENCE_COUNTRIES.has(intent.geo.toUpperCase());

      if (productMerchants.length > 0 || lazadaAvailable) {
        const searchKey = `${userId}:${cat.label}`;
        const stored = lastProductSearch.get(searchKey);
        const queryText = intent.product_query ?? stored?.query ?? cat.recommendations[0] ?? cat.label;

        // Re-search when the shopper actually said something new (a different query,
        // a country change) or we don't have a stored search yet — otherwise reuse
        // what we already found, same "don't silently re-search on every turn" logic
        // as hotels. wants_different_products is the explicit, unambiguous "no, not
        // these — something else" signal that overrides reuse even when the query
        // text itself is unchanged — real bug: "do you have other socks
        // recommendations?" kept the query as "socks" (same as before), so it looked
        // identical to just repeating the same search and kept returning the exact
        // same stored picks turn after turn.
        //
        // Hard disable, mirroring the exact fix already applied to hotels above (see
        // namingSpecificHotel / the "Park Royal" bug) — naming a specific product is a
        // NARROWING/decision signal, never a request for something new, and should
        // never spawn a fresh, unrelated search. Real bug (2026-07-06, Render logs):
        // "lets get the 4th one" kept re-triggering a full re-search that returned 5
        // completely different products (the one actually meant wasn't even among
        // them) — product_query gets re-extracted on every turn, and even a harmless
        // capitalization difference ("Samsung TV" vs "samsung tv", confirmed in the
        // logs one search apart) made queryChanged look true. When chosen_product_text
        // is set, ignore queryChanged entirely and trust the picks already shown —
        // only a genuinely new country, or an explicit "show me different ones",
        // should re-search. Query comparison is also now case/whitespace-insensitive
        // as defense in depth, so incidental re-extraction drift can't trigger this
        // even when chosen_product_text ISN'T set.
        const namingSpecificProduct = !!intent.chosen_product_text;
        const queryChanged =
          !namingSpecificProduct &&
          !!intent.product_query &&
          intent.product_query.trim().toLowerCase() !== (stored?.query ?? "").trim().toLowerCase();
        const countryChanged = !!intent.geo && intent.geo !== stored?.country;
        const shouldSearch = !stored || queryChanged || countryChanged || intent.wants_different_products;

        let productResult: ProductSearchResult | null = stored?.result ?? null;
        if (shouldSearch) {
          try {
            productResult = await searchCombinedProducts({
              query: queryText,
              country: intent.geo ?? stored?.country ?? "SG",
              merchants: productMerchants,
              budgetMax: intent.product_budget_max ?? undefined,
              // Only exclude previously-shown products when explicitly asked for
              // different ones — a normal re-search (new query/country) has no reason
              // to avoid a product just because it showed up in an unrelated earlier
              // search for this same category label.
              excludeProductIds:
                intent.wants_different_products && stored ? stored.result.picks.map((p) => p.productId) : undefined,
            });
          } catch (err) {
            console.error(`[agent] searchCombinedProducts failed:`, err instanceof Error ? err.message : err);
            productResult = null;
          }
        }

        if (!productResult) throw new Error(`No product search results for ${cat.label}`);

        // Resolve which product (if any) the shopper has singled out, mirroring the
        // hotel branch's chosenHotelId/chosenHotelOverride resolution.
        let chosenProductKey: string | undefined = shouldSearch ? undefined : stored?.chosenProductKey;
        let chosenProductOverride: ProductPick | undefined = shouldSearch ? undefined : stored?.chosenProductOverride;

        // Ordinal position ("number 4", "the 4th one") checked FIRST — a
        // deterministic, LLM-independent resolution for the single most common way
        // shoppers pick from a numbered list. See parseOrdinalPick's comment for the
        // real incident that motivated this.
        const ordinalIdx = parseOrdinalPick(rawText);
        if (ordinalIdx !== null && productResult.picks[ordinalIdx]) {
          const picked = productResult.picks[ordinalIdx];
          chosenProductKey = `${picked.merchant}:${picked.productId}`;
          chosenProductOverride = undefined;
          console.log(`[agent] resolved ordinal pick #${ordinalIdx + 1} -> "${picked.title}" for "${cat.label}"`);
        } else if (intent.chosen_product_text) {
          const needle = intent.chosen_product_text.trim().toLowerCase();
          // Exact substring match first; fall back to word-overlap (product-ranking.ts)
          // for cases where the LLM's resolved text is a close paraphrase of the real
          // title (different punctuation/separators, e.g. a "|" the LLM dropped) — a
          // real incident that made a correctly-identified pick silently fail to
          // resolve. Same 0.6 bar as the cross-platform "is this literally the same
          // item" check (shopee-price-check.ts) — verified live that a looser 0.5
          // would false-positive-match on a single shared category word (e.g. "the
          // sensodyne one" against an unrelated "Colgate Total Toothpaste").
          const match = productResult.picks.find((p) => {
            const title = p.title.toLowerCase();
            return needle.length > 0 && (title.includes(needle) || needle.includes(title) || titleWordOverlap(needle, title) >= 0.6);
          });
          if (match) {
            chosenProductKey = `${match.merchant}:${match.productId}`;
            chosenProductOverride = undefined;
          } else {
            const found = findProductPickByName({
              nameQuery: intent.chosen_product_text,
              country: intent.geo ?? stored?.country ?? "SG",
              merchants: productMerchants,
            });
            if (found) {
              chosenProductOverride = found;
              chosenProductKey = undefined;
              console.log(`[agent] resolved chosen_product_text "${intent.chosen_product_text}" via direct lookup (not in active picks)`);
            } else {
              console.log(`[agent] chosen_product_text "${intent.chosen_product_text}" matched nothing in active picks or local DB for "${cat.label}"`);
            }
          }
        }

        lastProductSearch.set(searchKey, {
          result: productResult,
          query: queryText,
          country: intent.geo ?? stored?.country ?? "SG",
          merchants: productMerchants,
          chosenProductKey,
          chosenProductOverride,
        });

        console.log(`[agent] product search: "${queryText}" -> ${productResult.picks.length} pick(s) for "${cat.label}"`);
        return {
          label: cat.label,
          recommendations: cat.recommendations,
          info: { id: "", name: cat.label } as MerchantInfo,
          link: null,
          productSearch: productResult,
          chosenProductKey,
          chosenProductOverride,
        } satisfies EnrichedCategory;
      }

      // Non-hotel: find first available merchant and optionally mint
      for (const platform of platforms) {
        const merchants = await searchMerchants({
          query: platform,
          geo: intent.geo,
          limit: 3,
          sort: "relevance",
        });

        if (merchants.length === 0) {
          console.log(`[agent] "${platform}" → 0 results, trying next`);
          continue;
        }

        console.log(`[agent] "${platform}" → ${merchants.length} result(s):`, merchants.map((m) => m.id));

        for (const merchant of merchants) {
          if (mintedMerchants.has(merchant.id)) continue;

          const info = await getMerchantInfo({ merchant_id: merchant.id, geo: intent.geo });
          if (!info || (info as { available?: boolean }).available === false) {
            console.warn(`[agent] ⚠️ ${merchant.id} not available — trying next`);
            continue;
          }

          mintedMerchants.add(merchant.id);

          if (!mintLinks) {
            console.log(`[agent] browsing mode, skipping ACP for ${merchant.id}`);
            return { label: cat.label, recommendations: cat.recommendations, info, link: null } satisfies EnrichedCategory;
          }

          console.log(`[agent] firing ACP job for ${merchant.id}`);
          const acpJob = mintJob(merchant.id, intent.geo);
          console.log(`[agent] ✅ ACP job started for "${cat.label}" (${merchant.id})`);
          return { label: cat.label, recommendations: cat.recommendations, info, link: null, acpJob } satisfies EnrichedCategory;
        }
      }

      // All platforms exhausted for this category
      console.warn(`[agent] ⚠️ no mintable merchant found for "${cat.label}" after trying:`, platforms);
      throw new Error(`No available merchant for ${cat.label}`);
    })
  );

  const results = categoryResults
    .filter((r): r is PromiseFulfilledResult<EnrichedCategory> => {
      if (r.status !== "fulfilled") {
        console.error("[agent] ❌", (r as PromiseRejectedResult).reason?.message ?? r);
      }
      return r.status === "fulfilled";
    })
    .map((r) => r.value);

  console.log(`[agent] ✅ ${results.length}/${intent.categories.length} categories resolved`);
  if (results.length === 0) {
    console.warn("[agent] ⚠️ 0 merchants resolved — check Laguna dev merchant list");
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step 3 — Pure Node.js response formatter (no LLM — no hallucinated URLs)
// ---------------------------------------------------------------------------

// No fallback URLs — every link MUST be minted via Laguna MCP.
// If Laguna doesn't have the merchant, we show the platform name only (no URL).

const CATEGORY_EMOJI: Record<string, string> = {
  flights:      "✈️",
  flight:       "✈️",
  hotels:       "🏨",
  hotel:        "🏨",
  activities:   "🎯",
  activity:     "🎯",
  tours:        "🗺️",
  transport:    "🚗",
  fashion:      "👗",
  apparel:      "👗",
  shopping:     "🛍️",
  supplements:  "💊",
  health:       "💊",
  electronics:  "💻",
  sports:       "👟",
  default:      "📌",
};

function emojiFor(label: string): string {
  const key = label.toLowerCase();
  return Object.entries(CATEGORY_EMOJI).find(([k]) => key.includes(k))?.[1]
    ?? CATEGORY_EMOJI.default;
}

// ---------------------------------------------------------------------------
// Cashback estimation helpers
// ---------------------------------------------------------------------------

/** Parse a cashback rate to a decimal fraction (e.g. "5%" → 0.05, 5 → 0.05, 0.05 → 0.05) */
function parseCashbackRate(rate: unknown): number | null {
  if (rate === null || rate === undefined || rate === "") return null;
  const n = typeof rate === "string"
    ? parseFloat(rate.replace(/%/g, "").trim())
    : Number(rate);
  if (isNaN(n) || n <= 0) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * Extract the first dollar amount from a recommendation string.
 * Handles: "~$120/night", "from ~$650 return", "($35)", "$1,299"
 */
function extractPrice(text: string): number | null {
  const m = text.match(/\$[\d,]+(\.\d+)?/);
  if (!m) return null;
  return parseFloat(m[0].replace(/[$,]/g, ""));
}

/**
 * Extract the real cashback rate from get_merchant_info response.
 * The API returns: { cashback: { best_rate: 9 } } where 9 means 9%.
 */
function extractRate(
  info: MerchantInfo,
): { rate: number; isEstimate: boolean } | null {
  // Primary: cashback.best_rate (e.g. 9 → 9% → 0.09)
  const bestRate = info?.cashback?.best_rate;
  if (bestRate !== null && bestRate !== undefined) {
    const n = Number(bestRate);
    if (!isNaN(n) && n > 0) return { rate: n / 100, isEstimate: false };
  }

  // Fallback: category_rates[0].rate
  const catRates = info?.cashback?.category_rates;
  if (Array.isArray(catRates) && catRates.length > 0) {
    const n = Number(catRates[0].rate);
    if (!isNaN(n) && n > 0) return { rate: n / 100, isEstimate: false };
  }

  console.warn(`[agent] no cashback rate in get_merchant_info response for ${info?.id ?? "unknown"}`);
  return null;
}

function buildReply(
  intent: GoalIntent,
  enriched: EnrichedCategory[],
  hasWallet: boolean,
  userCountry?: string,
  purchaseReady: boolean = false
): string {
  const enrichedByLabel = new Map(enriched.map((e) => [e.label, e]));
  const lines: string[] = [];
  let anyProductChosenThisTurn = false;

  // Resolve each category's "chosen" pick BEFORE deciding the intro line, so the
  // generic "Here are some options for X!" opener can be skipped entirely when every
  // category this turn is purely a confirmation (a chosen hotel/product), not a fresh
  // list. Real user feedback (2026-07-06): saying "here are some options" immediately
  // before "Got it — <the one specific thing you picked>" reads as contradictory —
  // there weren't "some options" shown this turn, just a direct confirmation.
  const categoriesToShow = intent.categories.slice(0, 4);
  const resolvedCategories = categoriesToShow.map((cat) => {
    const matched = enrichedByLabel.get(cat.label);
    const agodaPicks = matched?.agodaSmart?.picks ?? [];
    const productPicks = matched?.productSearch?.picks ?? [];

    // Once the traveller has both said they're purchase-ready AND singled out a specific
    // hotel by name, re-printing the full 3-option list (often with a freshly re-ranked,
    // different-looking set of picks) is noise — they've already decided. Just confirm
    // and let the separate booking-link follow-up do its job.
    const chosenForConfirm =
      matched?.chosenHotelOverride ??
      (matched?.chosenHotelId != null ? agodaPicks.find((p) => p.hotelId === matched.chosenHotelId) : undefined);

    // Mirrors chosenForConfirm above, but for products. Unlike hotels this is NOT gated on
    // purchaseReady — naming a product ("let's buy the kleenex") deliberately stays
    // purchase_ready:false for retail (see extractIntent's prompt) since there's no ACP
    // mint to guard against yet, but the shopper still wants THAT item's link the moment
    // they name it, not buried back in the full list.
    const chosenProductPick: ProductPick | undefined =
      matched?.chosenProductOverride ??
      (matched?.chosenProductKey != null
        ? productPicks.find((p) => `${p.merchant}:${p.productId}` === matched.chosenProductKey)
        : undefined);

    return { cat, matched, agodaPicks, productPicks, chosenForConfirm, chosenProductPick };
  });

  const allConfirmedOnly =
    resolvedCategories.length > 0 &&
    resolvedCategories.every((r) => (purchaseReady && r.chosenForConfirm) || r.chosenProductPick);

  if (!allConfirmedOnly) {
    if (purchaseReady) {
      lines.push(`Great choice! Here's what I found for *${intent.goal}*.\n`);
    } else {
      lines.push(`Here are some options for *${intent.goal}*!\n`);
    }
  }

  for (const { cat, matched, agodaPicks, productPicks, chosenForConfirm, chosenProductPick } of resolvedCategories) {
    const emoji = emojiFor(cat.label);
    lines.push(`${emoji} *${cat.label}*`);
    const recs = cat.recommendations.slice(0, 3);

    if (purchaseReady && chosenForConfirm) {
      lines.push(`Got it — locking in *${chosenForConfirm.hotelName}* for your stay. Sending the booking link next! 🔗`);
    } else if (chosenProductPick) {
      anyProductChosenThisTurn = true;
      // Direct link policy (2026-07-05): Shopee/iHerb have no ACP mint path worth taking
      // (no live affiliate program / no bridge special case yet), so show the raw
      // productUrl straight from our own catalog instead of deferring to a mint-then-
      // follow-up message.
      const price = chosenProductPick.salePrice ?? chosenProductPick.price;
      let priceStr = "";
      if (price !== null) {
        const wasDiscounted =
          chosenProductPick.salePrice !== null && chosenProductPick.price !== null && chosenProductPick.salePrice < chosenProductPick.price;
        priceStr = ` · ${chosenProductPick.currency ?? ""} ${price.toFixed(2)}${wasDiscounted ? ` (was ${chosenProductPick.currency ?? ""} ${chosenProductPick.price!.toFixed(2)})` : ""}`;
      }
      lines.push(`Got it — *${chosenProductPick.title}* (${platformLabel(chosenProductPick.merchant)})${priceStr}. Here's the direct link:`);
      lines.push(chosenProductPick.productUrl ?? "_(no direct link on file for this one — sorry!)_");
    } else if (productPicks.length > 0) {
      // Real Shopee/iHerb picks from our own catalog — grounded facts, not LLM guesses.
      // Mirrors the hotel branch: no link shown in the recommendation list itself — the
      // direct product_url is only sent once the user names a specific pick (see the
      // chosenProductPick branch above).
      //
      // isExactMatch=false (see product-search.ts's titleMatchesQuery) means none of
      // these actually matched the query in their title — e.g. asking for "toothbrush"
      // and the catalog only has oral-care items that surfaced via a category/description
      // mention. Per explicit instruction, don't drop the category to silence in that
      // case — say plainly we didn't find a great match and offer the closest items
      // instead, rather than presenting them as if they were what was asked for.
      const isExactMatch = matched?.productSearch?.isExactMatch ?? true;
      if (!isExactMatch) {
        lines.push(`Couldn't find a great match for that — here are the closest items we have:`);
      }
      productPicks.forEach((pick, i) => {
        const price = pick.salePrice ?? pick.price;
        let priceStr = "";
        if (price !== null) {
          const wasDiscounted = pick.salePrice !== null && pick.price !== null && pick.salePrice < pick.price;
          priceStr = ` · ${pick.currency ?? ""} ${price.toFixed(2)}${wasDiscounted ? ` (was ${pick.currency ?? ""} ${pick.price!.toFixed(2)})` : ""}`;
        }
        // reviewCount (Lazada/live-Shopee) is the real signal when we have it; soldCount
        // (local datafeed's only volume signal) is shown otherwise — see product-ranking.ts.
        const volumeStr = pick.reviewCount ? ` · ${pick.reviewCount} reviews` : pick.soldCount ? ` · ${pick.soldCount} sold` : "";
        const ratingStr = pick.rating ? ` (★${pick.rating}${volumeStr})` : "";
        const officialStr = pick.isOfficial ? " ✅ Official Store" : "";
        // Picks can now come from more than one marketplace in the same shortlist (see
        // searchCombinedProducts) — always say which one, per the decided cross-platform
        // presentation policy (project memory).
        lines.push(`${i + 1}. *${pick.title}* (${platformLabel(pick.merchant)}) — ${pick.reasoning}${priceStr}${ratingStr}${officialStr}`);
        if (i < productPicks.length - 1) lines.push("");
      });
      lines.push(`\n_Which one? I'll send the direct link once you pick._`);
    } else if (agodaPicks.length > 0) {
      // Real hotel picks from our own DB — grounded facts, not LLM guesses. Price shown is
      // either a live Agoda price (Stage B has run) or a static database estimate.
      agodaPicks.forEach((pick, i) => {
        const distanceStr = pick.distanceKm !== null ? ` · ${pick.distanceKm.toFixed(1)}km away` : "";
        // Never show "price on request" — per explicit request. If neither a live nor a
        // static estimate is available, just omit the price segment entirely rather than
        // saying something unhelpful.
        let priceStr = "";
        if (pick.liveDailyRate !== undefined) {
          // "sell exclusive" per Agoda's affiliate API spec — this is NOT the final,
          // tax/fee-inclusive price shown at agoda.com checkout, which typically runs
          // higher. Said explicitly here rather than implying it's the final total.
          priceStr = ` · ${pick.liveCurrency ?? pick.currency ?? "USD"} ${pick.liveDailyRate.toFixed(0)}/night (live, excl. taxes & fees)`;
        } else if (pick.approxRatePerNight !== null) {
          priceStr = ` · ~${pick.currency ?? "USD"} ${pick.approxRatePerNight.toFixed(0)}/night (est.)`;
        }
        const ratingStr = pick.starRating ? ` (★${pick.starRating}${pick.reviewScore ? ` · ${pick.reviewScore}/10` : ""})` : "";
        lines.push(`${i + 1}. *${pick.hotelName}* — ${pick.reasoning}${priceStr}${distanceStr}${ratingStr}`);
        if (i < agodaPicks.length - 1) lines.push(""); // blank line between options, not after the last
      });
    } else {
      // Fall back to Step 1's LLM-knowledge recommendations (no real search data yet —
      // e.g. dates not given, or city didn't resolve to an Agoda city_id).
      recs.forEach((rec, i) => {
        lines.push(`${i + 1}. ${rec}`);
        if (i < recs.length - 1) lines.push(""); // blank line between options, not after the last
      });
    }

    // The dedicated Agoda booking link is sent as its OWN follow-up message (see
    // buildBookingLinkMessage / its call site in _processMessage) — not bundled in here
    // with the recommendation list, per explicit request.

    // Generic Laguna/ACP merchant line — only when an actual merchant was resolved
    // (the hotel branch can return agodaSmart alone with no ACP merchant at all), and
    // only when there's something actionable to show (a real link, or one in flight).
    // No bare "→ via Trip.com" placeholder when nothing's actually happening yet.
    const hasMerchant = !!(matched && (matched.info?.id || matched.link || matched.acpJob));

    if (hasMerchant && (matched!.link?.shortlink || matched!.acpJob)) {
      const primaryName = matched!.info?.name ?? matched!.info?.id ?? cat.label;

      if (matched!.link?.shortlink) {
        lines.push(`→ Book via *${primaryName}*: ${matched!.link.shortlink}`);
      } else {
        // Extra platforms inline (e.g. "also on Agoda")
        const extras = (matched!.extraPlatforms ?? []).map(ep => ep.name).join(" & ");
        const alsoStr = extras ? ` (also on ${extras})` : "";
        lines.push(`→ We recommend booking via *${primaryName}*${alsoStr} — _affiliate link coming shortly_ ⏳`);
      }
    } else if (!hasMerchant && agodaPicks.length === 0 && productPicks.length === 0) {
      // Nothing resolved at all for this category — no merchant, no real search results.
      lines.push(`→ via ${cat.platform_search}`);
    }

    lines.push(""); // blank line between categories
  }

  if (purchaseReady) {
    // Generic cashback line — no merchant-specific rate/dollar breakdown anymore, just
    // one consistent line whenever at least one bookable link exists.
    const hasAnyLink = enriched.some((e) => e.acpJob || e.link?.shortlink);
    if (hasAnyLink) {
      lines.push(`_Receive up to 6% in cashback when you book via our link 💸_`);
    }
  } else if (anyProductChosenThisTurn) {
    // Already handed over a direct link above for the item they named — don't immediately
    // follow it with "which of these catches your eye", which reads as if nothing happened.
    lines.push(`Want to look at anything else, or need another item?`);
  } else {
    // Browsing mode — soft close, invite them to pick
    lines.push(`Which of these catches your eye? Happy to dig deeper or send you a booking link when you're ready!`);
  }

  if (userCountry) {
    lines.push(`\n_Showing options for *${userCountry}*. Different region? \`/setcountry\`_`);
  }

  if (!hasWallet) {
    lines.push(
      `\n📊 _Want to track your rebates? Save your wallet:_\n\`/setwallet 0xYourAddress\``
    );
  }

  return lines.join("\n");
}

// Builds the dedicated, dated, hotel-tagged Agoda booking link as its OWN message body —
// sent as a separate follow-up (see _processMessage) rather than bundled into the main
// recommendation list, per explicit request ("do not include it with the other suggested
// options. Just give it in a new message"). Same chosen-hotel priority as before:
// chosenHotelOverride (named hotel resolved outside the active picks, e.g. filtered out by
// a later budget change) beats a chosenHotelId match within agodaPicks, which beats the
// top-ranked pick if the traveller never singled one out. Returns null when there's
// nothing purchase-ready to show yet, or no link is actually available.
//
// Explicit policy (2026-07-05): Agoda gets a DIRECT link, no ACP mint_link call at all.
// chosen.landingURL already comes from Yixin's own Agoda Affiliate Long Tail Search API
// (AGODA_SITE_ID baked in server-side — see agoda-api.ts/agoda-search.ts), which means it's
// ALREADY a real, wallet-independent, commission-tracked affiliate link on its own — no
// Involve Asia/ACP round-trip needed on top of it for cashback attribution to work. This
// also sidesteps an entire class of bugs the ACP path went through today (target_url never
// actually being forwarded to the job, Telegram Markdown delivery failures, a 404'd
// shortlink) in favor of something simpler and already proven to work. Shopee/iHerb
// (buildReply's chosenProductPick branch) follow the same direct-link policy — see there for
// why. Laguna's generic ACP mint_link stays in use for every OTHER merchant (Trip.com, and
// anything resolved via the generic Laguna-merchant-search fallback) where we don't have our
// own affiliate-tracked link to hand back directly.
async function buildBookingLinkMessage(
  intent: GoalIntent,
  enriched: EnrichedCategory[],
  purchaseReady: boolean,
  _walletAddress: string
): Promise<string | null> {
  if (!purchaseReady) return null;

  const enrichedByLabel = new Map(enriched.map((e) => [e.label, e]));
  const lines: string[] = [];

  for (const cat of intent.categories.slice(0, 4)) {
    const matched = enrichedByLabel.get(cat.label);
    const agodaPicks = matched?.agodaSmart?.picks ?? [];
    const chosen =
      matched?.chosenHotelOverride ??
      (matched?.chosenHotelId != null ? agodaPicks.find((p) => p.hotelId === matched.chosenHotelId) : undefined) ??
      (agodaPicks.length > 0 ? agodaPicks[0] : undefined);
    if (chosen?.landingURL) {
      lines.push(`→ Book *${chosen.hotelName}* directly on Agoda: ${chosen.landingURL}`);
    }
  }

  return lines.length > 0 ? lines.join("\n\n") : null;
}

// REMOVED (2026-07-05): buildProductLinkMessage/ACP mint for Shopee/iHerb products, per the
// same direct-link policy as Agoda above (plus iHerb specifically has no ACP bridge special
// case yet, and Shopee has no live affiliate program at all — an ACP mint attempt for either
// was never going to land on a real, product-specific tracked link). buildReply's
// chosenProductPick branch now shows chosen.productUrl directly instead of deferring to a
// separate mint-then-follow-up message.

// Commit-time cross-check against Shopee, added 2026-07-06 once Lazada joined the combined
// search (see project memory "Charted Sea live search eval" — "handle both at once ... only
// when the shopper says they want this specific product, send the Lazada SKU link, and at the
// same time check Shopee for a cheaper or similar item"). Runs as its OWN async follow-up,
// never inline: the shopper already has the Lazada link from the synchronous reply above, and
// the live Shopee scraper alone can take 2+ minutes (see shopee-live-search.ts) — this is
// purely additive, never something worth making them wait for.
//
// Gated on intent.chosen_product_text being set THIS turn (not on the persisted
// chosenProductKey/chosenProductOverride on EnrichedCategory, which survive across turns via
// lastProductSearch) — otherwise this expensive check would re-fire on every single message
// after a commit, not just the turn the shopper actually named something.
//
// Only fires for a Lazada-sourced pick, per the decided design: Shopee/iHerb picks don't get
// the reverse check (a possible future extension, not built here — out of the explicitly
// agreed scope for this pass).
async function buildShopeePriceCheckMessage(intent: GoalIntent, enriched: EnrichedCategory[]): Promise<string | null> {
  if (!intent.chosen_product_text) return null;

  const enrichedByLabel = new Map(enriched.map((e) => [e.label, e]));
  const country = intent.geo ?? "SG";

  for (const cat of intent.categories.slice(0, 4)) {
    const matched = enrichedByLabel.get(cat.label);
    const productPicks = matched?.productSearch?.picks ?? [];
    const chosen =
      matched?.chosenProductOverride ??
      (matched?.chosenProductKey != null
        ? productPicks.find((p) => `${p.merchant}:${p.productId}` === matched.chosenProductKey)
        : undefined);

    if (!chosen || chosen.merchant !== "lazada") continue;

    try {
      return await checkShopeeAlternative(chosen, country);
    } catch (err) {
      console.error(`[agent] Shopee price-check failed for "${chosen.title}":`, err instanceof Error ? err.message : err);
      return `Checked Shopee for *${chosen.title}* but couldn't get a reliable comparison right now — the Lazada link above is still good to go.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function processMessage(
  userId: number,
  text: string,
  walletAddress: string,      // empty string means no wallet set yet
  userCountry?: string,       // ISO alpha-2, e.g. "SG"
  onFollowUp?: (msg: string) => Promise<void>  // called when ACP links settle
): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: text });

  // Timeout covers only the fast path (LLM + Laguna search); ACP runs beyond this.
  // Raised 50s->70s (2026-07-06, Yixin's call) to give inline Lazada search room to
  // use its own newly-raised 45s budget (see INLINE_LAZADA_TIMEOUT_MS in
  // product-search.ts) plus the 20s Kimi ranking step, after live-measuring Charted
  // Sea latency scaling to ~44s under concurrent queue load. This is a deliberate
  // trade: an unlucky turn (slow Lazada + slow ranking + slow intent extraction all
  // at once) can still exceed 70s, but it's a much rarer combination than a single
  // Lazada call alone exceeding a tighter budget. No external constraint forces this
  // number — bot.ts ACKs the Telegram webhook immediately and processes in the
  // background (confirmed 2026-07-06), so raising this only affects how long the user
  // waits for their reply, not any infra timeout.
  const PIPELINE_TIMEOUT_MS = 70_000;
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<string>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("pipeline timeout")), PIPELINE_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race(
      [_processMessage(userId, text, walletAddress, userCountry, history, onFollowUp), timeoutPromise]
    );
    clearTimeout(timeoutId!);
    return result;
  } catch (err) {
    clearTimeout(timeoutId!);
    const msg = (err as Error).message ?? "";
    if (msg === "pipeline timeout") {
      console.error(`[agent] ⏱ pipeline timed out after ${PIPELINE_TIMEOUT_MS / 1000}s`);
      return "⏱ That took too long — the AI or merchant API is slow right now. Please try again in a moment.";
    }
    throw err;
  }
}

async function _processMessage(
  userId: number,
  text: string,
  walletAddress: string,
  userCountry: string | undefined,
  history: ChatMessage[],
  onFollowUp?: (msg: string) => Promise<void>
): Promise<string> {
  try {
    // Skip intent extraction for short casual greetings only.
    // Any message referencing shopping/products/travel → always extractIntent.
    const SHOPPING_KEYWORDS = /hotel|flight|book|buy|shop|trip|travel|order|plan|stay|rent|find|search|recommend|get me|cheapest|best|vitamin|supplement|pill|skincare|shoe|shirt|bag|watch|phone|laptop|ticket|tour|activity|iherb|nike|klook|shein|temu|crocs|puma/i;
    const isCasual = text.trim().split(/\s+/).length <= 3 && !SHOPPING_KEYWORDS.test(text);

    let reply: string;

    if (isCasual) {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);
      const cleanReply = reply.slice(0, 1200);
      history.push({ role: "assistant", content: cleanReply });
      if (history.length > 21) history.splice(1, history.length - 21);
      return reply;
    }

    const intent = await extractIntent(history, text);

    // Always prefer the user's stored country over whatever the LLM extracted.
    // The user set this during onboarding — no need for the LLM to re-detect it.
    if (userCountry) intent.geo = userCountry;

    const hasCategories =
      (intent.intent === "travel_booking" ||
        intent.intent === "retail_shopping" ||
        intent.intent === "product_comparison") &&
      intent.categories.length > 0;

    if (intent.is_dashboard_query) {
      reply = "Use /dashboard to check your affiliate earnings and cashback history.";

    } else if (intent.is_off_topic) {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);

    } else if (hasCategories) {
      const purchaseReady = intent.purchase_ready ?? false;
      console.log(`[agent] running tools: ${intent.intent} | ${intent.categories.map(c => c.label).join(", ")} | geo: ${intent.geo ?? userCountry ?? "none"} | purchase_ready=${purchaseReady}`);
      const enriched = await runTools(intent, walletAddress, userId, text, purchaseReady);
      reply = buildReply(intent, enriched, !!walletAddress, userCountry, purchaseReady);

      // For each ACP job in flight, send follow-up when it settles
      if (onFollowUp) {
        for (const cat of enriched) {
          const primaryName = cat.info?.name ?? cat.info?.id ?? cat.label;

          // If there are extra platforms (agoda + trip), bundle all links into one message
          const extraJobs = (cat.extraPlatforms ?? []).filter(ep => ep.acpJob);
          const allJobs = [
            ...(cat.acpJob ? [{ name: primaryName, job: cat.acpJob, info: cat.info }] : []),
            ...extraJobs.map(ep => ({ name: ep.name, job: ep.acpJob!, info: ep.info })),
          ];

          if (allJobs.length === 0) continue;

          // Wait for all platform links then send one combined message
          Promise.allSettled(allJobs.map(j => j.job)).then((results) => {
            const linkLines: string[] = [];
            results.forEach((r, i) => {
              const { name } = allJobs[i];
              if (r.status === "fulfilled") {
                linkLines.push(`🔗 *${name}*\n${r.value.shortlink}`);
              }
            });
            if (linkLines.length > 0) {
              linkLines.push(`_Receive up to 6% in cashback when you book via our link 💸_`);
              return onFollowUp(linkLines.join("\n\n"));
            }
          }).catch((err) => {
            console.error(`[acp] follow-up failed for ${primaryName}:`, err instanceof Error ? err.message : err);
          });
        }

        // Dedicated Agoda booking link, sent as its OWN separate message rather than
        // bundled into the reply above — per explicit request. Direct link now (no ACP
        // mint, see buildBookingLinkMessage's comment), so this resolves essentially
        // instantly, but stays a separate follow-up message for the same UX reason as
        // before.
        buildBookingLinkMessage(intent, enriched, purchaseReady, walletAddress)
          .then((bookingLinkMsg) => {
            if (bookingLinkMsg) return onFollowUp(bookingLinkMsg);
          })
          .catch((err) => {
            console.error(`[agent] booking-link follow-up failed:`, err instanceof Error ? err.message : err);
          });

        // Shopee cross-check, fired only the turn the shopper names a specific Lazada
        // pick — see buildShopeePriceCheckMessage's comment for the full gating logic
        // and why this is async/separate rather than inline.
        buildShopeePriceCheckMessage(intent, enriched)
          .then((priceCheckMsg) => {
            if (priceCheckMsg) return onFollowUp(priceCheckMsg);
          })
          .catch((err) => {
            console.error(`[agent] Shopee price-check follow-up failed:`, err instanceof Error ? err.message : err);
          });
      }

      // Append clarification if something important is still missing
      if (intent.needs_clarification && intent.clarification_question) {
        reply += `\n\n_${intent.clarification_question}_`;
      }

    } else {
      // General question or not enough info — converse naturally
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);
    }

    // Cap stored reply to prevent context ballooning over long sessions
    const cleanReply = reply.slice(0, 1200); // cap stored turn to avoid ballooning context
    history.push({ role: "assistant", content: cleanReply });

    // Keep system prompt + last 20 turns
    if (history.length > 21) {
      history.splice(1, history.length - 21);
    }

    return reply;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent] error processing message:", msg);
    history.pop();
    throw err;
  }
}
