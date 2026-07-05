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
import { searchLocalHotels, fetchLiveAgodaPrices, type LocalSearchResult, type HotelPick } from "./agoda-search.js";
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
}
const lastHotelSearch = new Map<number, StoredHotelSearch>();

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
- Hotel prices you show at first are database estimates, not live prices. If the user seems to
  want exact current pricing, mention they can ask you to "check real-time prices."

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
  // Free text describing what matters to the traveller for hotel choice —
  // location/distance, vibe, amenities — passed to Kimi for ranking, not a fixed filter.
  hotel_preference_text: z.string().nullish(),
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
Set purchase_ready: true ONLY if the user EXPLICITLY asks for the link to book or purchase —
e.g. "give me the link to book", "send me the purchase link", "can I get the booking link",
"link please", "share the link so I can buy it". This must be a direct request for the link
itself, not just general enthusiasm or a decision.
Set purchase_ready: false for everything else — including "book this", "I'll go with the
Marriott", "I want to buy it", "let's do it", "I'm ready", or comparing named options. Those
signal a decision, not a request for the link, so keep purchase_ready: false until they
explicitly ask for the link. When in doubt, default to false.

## Hotel search fields (only fill when a hotel/stay/accommodation category is present)
- "destination_city": ONLY the city or place name the hotel search is for — e.g. "Bangkok", "Singapore", "New York". NEVER a full sentence, NEVER a neighbourhood-only value, NEVER the category label. This is looked up in an exact city database, so it must be just the place name a city lookup would recognise. Null if no destination is clear yet.
- "checkin_date" / "checkout_date": absolute YYYY-MM-DD, resolved from whatever the user said relative to today (${todayISO}). Null if no dates mentioned at all — do NOT guess dates the user never implied.
- "adults" / "children": default adults=2, children=0 if travel party size isn't mentioned.
- "budget_max_per_night": a number if the user gave any per-night/total budget hint, else null.
- "hotel_preference_text": capture ANY location/proximity cue LITERALLY, keeping the actual place name intact — e.g. "near Thonglor" not "nightlife area", "close to Marina Bay Sands" not "near the water". This gets geocoded downstream, so a specific real name matters far more than a vibe description. If there's no location cue, other preferences (vibe, must-have amenities) are fine here too. Null if nothing beyond price/stars was said.
- If destination_city, checkin_date, or checkout_date is missing for a hotel search, set needs_clarification: true and ask for whichever is missing in clarification_question — but still fill in categories/recommendations from what you know so the user gets a useful reply either way.

## wants_realtime_prices detection (separate from purchase_ready)
Set wants_realtime_prices: true if the user asks to check/search/confirm CURRENT or LIVE prices
for hotels already shown — e.g. "search realtime for these", "check real prices", "what are the
actual current rates", "get live prices for these 3", "use the agoda api to check prices". This
is about wanting up-to-date pricing, NOT about wanting the booking link — someone can want live
prices without being purchase_ready, and vice versa. Default false.

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
  "destination_city": string|null,
  "checkin_date": string|null,
  "checkout_date": string|null,
  "adults": number|null,
  "children": number|null,
  "budget_max_per_night": number|null,
  "hotel_preference_text": string|null
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
}

async function runTools(
  intent: GoalIntent,
  walletAddress: string,
  userId: number,
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
    shopping:       ["temu", "shein-global", "zalora"],
    supplements:    ["iherb"],
    health:         ["iherb"],
    electronics:    ["lenovo"],
    sports:         ["nike", "puma", "crocs"],
    luxury:         ["vertu", "farfetch"],
  };

  // Keywords used to auto-append safety-net fallbacks for unlisted categories
  const TRAVEL_RE   = /hotel|flight|travel|trip|cruise|tour|activit|transport|transfer|ferry|train|rail|car\s*rent|accommodation/i;
  const SHOPPING_RE = /shop|fashion|apparel|cloth|wear|bag|shoe|accessor|gift|beauty|cosmetic/i;

  function platformsForCategory(label: string, primary: string): string[] {
    const key = label.toLowerCase();
    const defaults =
      Object.entries(CATEGORY_PLATFORMS).find(([k]) => key.includes(k))?.[1] ?? [];
    const list = [primary, ...defaults.filter((p) => p !== primary)];

    // Safety-net: any unrecognised travel category → append trip-com as last resort
    if (TRAVEL_RE.test(label) && !list.includes("trip-com")) {
      list.push("trip-com");
    }
    // Safety-net: any unrecognised shopping category → append shein-global / temu
    if (SHOPPING_RE.test(label) && !list.some((p) => ["shein-global", "temu", "nike"].includes(p))) {
      list.push("shein-global", "temu");
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

      // For hotels: always mint BOTH trip-com and agoda in parallel, AND (new) run our own
      // local hotel search + Kimi ranking alongside it whenever we have enough info
      // (destination + dates) — Stage A, no live API call, blended into every reply.
      // Live Agoda pricing (Stage B) only happens on explicit request — see below.
      if (isHotel) {
        // destination_city is a clean place name from the LLM (e.g. "Bangkok") — required for
        // an exact-match city lookup. cat.label/intent.goal are full sentences and never match.
        const canSearch = !!(intent.destination_city && intent.checkin_date && intent.checkout_date);
        const stored = lastHotelSearch.get(userId);

        // Only treat this as a genuinely NEW search if this turn actually SAID something
        // that differs from the stored search — a different city, different dates, a new
        // preference/budget. Crucially: if this turn's extraction came back null for a
        // field (e.g. hotel_preference_text, because the message was "get prices for these
        // 3 hotels" with no location cue in it), that must NOT count as "changed" — it just
        // means the user didn't repeat themselves, and we should keep using what we already
        // had rather than silently re-searching without it (which is what produced a
        // different, ungeocoded, generic set of hotels than the ones actually being
        // discussed).
        const cityChanged = !!intent.destination_city && intent.destination_city !== stored?.cityQuery;
        const datesChanged =
          (!!intent.checkin_date && intent.checkin_date !== stored?.checkinDate) ||
          (!!intent.checkout_date && intent.checkout_date !== stored?.checkoutDate);
        const preferenceChanged =
          !!intent.hotel_preference_text && intent.hotel_preference_text !== stored?.preferenceText;
        const budgetChanged =
          intent.budget_max_per_night != null && intent.budget_max_per_night !== stored?.budgetMaxPerNight;

        const shouldSearch =
          canSearch && (!stored || cityChanged || datesChanged || preferenceChanged || budgetChanged);

        const localSearchPromise: Promise<LocalSearchResult | null> = shouldSearch
          ? searchLocalHotels({
              cityQuery: intent.destination_city!,
              checkinDate: intent.checkin_date!,
              checkoutDate: intent.checkout_date!,
              adults: intent.adults ?? 2,
              children: intent.children ?? 0,
              budgetMaxPerNight: intent.budget_max_per_night ?? undefined,
              preferenceText: intent.hotel_preference_text ?? undefined,
              countryHint: intent.geo,
            }).catch((err) => {
              console.error(`[agent] searchLocalHotels failed:`, err instanceof Error ? err.message : err);
              return null;
            })
          // Nothing material changed this turn — if we have a stored search, always reuse it
          // (regardless of wants_realtime_prices/mintLinks) so "these 3 hotels" keeps meaning
          // the same 3 hotels. Only fall through to null if we truly have nothing yet.
          : Promise.resolve(stored ? stored.result : null);

        const [tripResult, agodaResult, localSearchResult] = await Promise.allSettled([
          resolveMerchant("trip-com", intent.geo),
          resolveMerchant("agoda", intent.geo),
          localSearchPromise,
        ]);

        const trip = tripResult.status === "fulfilled" ? tripResult.value : null;
        const agoda = agodaResult.status === "fulfilled" ? agodaResult.value : null;
        let agodaSmart = localSearchResult.status === "fulfilled" ? localSearchResult.value ?? undefined : undefined;

        // Stage B — live Agoda pricing — only when explicitly asked for real-time prices,
        // or purchase_ready needs live data to produce a real booking link.
        if (agodaSmart && (intent.wants_realtime_prices || mintLinks)) {
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
            });
          }
        }

        if (!trip && !agoda && !agodaSmart) throw new Error(`No hotel merchants available for ${cat.label}`);

        // No Laguna-side merchant resolved at all, but the real Agoda search still
        // came back — return that alone rather than failing the whole category.
        if (!trip && !agoda) {
          console.log(`[agent] hotel: no ACP merchant resolved for "${cat.label}", but agodaSmart has ${agodaSmart!.picks.length} pick(s)`);
          return {
            label: cat.label,
            recommendations: cat.recommendations,
            info: { id: "", name: cat.label } as MerchantInfo,
            link: null,
            agodaSmart,
          } satisfies EnrichedCategory;
        }

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

  if (purchaseReady) {
    lines.push(`Great choice! Here's what I found for *${intent.goal}*.\n`);
  } else {
    lines.push(`Here are some options for *${intent.goal}*!\n`);
  }

  for (const cat of intent.categories.slice(0, 4)) {
    const emoji = emojiFor(cat.label);
    const matched = enrichedByLabel.get(cat.label);

    lines.push(`${emoji} *${cat.label}*`);

    const agodaPicks = matched?.agodaSmart?.picks ?? [];
    const recs = cat.recommendations.slice(0, 3);

    let anyLivePrice = false;

    if (agodaPicks.length > 0) {
      // Real hotel picks from our own DB — grounded facts, not LLM guesses. Price shown is
      // either a live Agoda price (Stage B has run) or a static database estimate.
      agodaPicks.forEach((pick, i) => {
        const distanceStr = pick.distanceKm !== null ? ` · ${pick.distanceKm}km away` : "";
        let priceStr: string;
        if (pick.liveDailyRate !== undefined) {
          anyLivePrice = true;
          priceStr = `${pick.liveCurrency ?? pick.currency ?? "USD"} ${pick.liveDailyRate.toFixed(0)}/night (live)`;
        } else if (pick.approxRatePerNight !== null) {
          priceStr = `~${pick.currency ?? "USD"} ${pick.approxRatePerNight.toFixed(0)}/night (est.)`;
        } else {
          priceStr = "price on request";
        }
        const ratingStr = pick.starRating ? ` (★${pick.starRating}${pick.reviewScore ? ` · ${pick.reviewScore}/10` : ""})` : "";
        lines.push(`${i + 1}. *${pick.hotelName}* — ${pick.reasoning} · ${priceStr}${distanceStr}${ratingStr}`);
      });
    } else {
      // Fall back to Step 1's LLM-knowledge recommendations (no real search data yet —
      // e.g. dates not given, or city didn't resolve to an Agoda city_id).
      recs.forEach((rec, i) => {
        lines.push(`${i + 1}. ${rec}`);
      });
    }

    // Reveal the specific, dated, hotel-tagged Agoda booking link only once the
    // user is purchase-ready — same "don't push links while browsing" rule as
    // everything else in this bot.
    if (agodaPicks.length > 0 && purchaseReady) {
      const top = agodaPicks[0];
      if (top.landingURL) {
        lines.push(`→ Book *${top.hotelName}* directly on Agoda: ${top.landingURL}`);
      } else {
        lines.push(`→ Couldn't confirm a live booking link for *${top.hotelName}* just now — try again in a moment.`);
      }
    } else if (agodaPicks.length > 0 && !anyLivePrice) {
      // Static estimates only — let the user know they can ask for the real thing.
      lines.push(`_Prices above are database estimates — ask me to "check real-time prices" for exact numbers._`);
    }

    // Generic Laguna/ACP merchant line — only when an actual merchant was resolved
    // (the hotel branch can return agodaSmart alone with no ACP merchant at all).
    const hasMerchant = !!(matched && (matched.info?.id || matched.link || matched.acpJob));

    if (hasMerchant) {
      const primaryName = matched!.info?.name ?? matched!.info?.id ?? cat.label;

      // Build one clean booking line — no merchant-specific rebate % shown here anymore;
      // see the generic cashback line appended once at the end of the reply instead.
      if (matched!.link?.shortlink) {
        lines.push(`→ Book via *${primaryName}*: ${matched!.link.shortlink}`);
      } else if (matched!.acpJob) {
        // Extra platforms inline (e.g. "also on Agoda")
        const extras = (matched!.extraPlatforms ?? []).map(ep => ep.name).join(" & ");
        const alsoStr = extras ? ` (also on ${extras})` : "";
        lines.push(`→ We recommend booking via *${primaryName}*${alsoStr} — _affiliate link coming shortly_ ⏳`);
      } else {
        lines.push(`→ via *${primaryName}*`);
      }
    } else if (agodaPicks.length === 0) {
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

  // Timeout covers only the fast path (LLM + Laguna search); ACP runs beyond this
  const PIPELINE_TIMEOUT_MS = 50_000;
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
      const enriched = await runTools(intent, walletAddress, userId, purchaseReady);
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
