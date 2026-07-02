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
import { z } from "zod";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map<number, ChatMessage[]>();

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

## Purchase intent signals (system will then send links)
Examples: "I'll go with...", "book this", "I want to buy", "send me the link", "which one should I get"

## When there's no purchase intent yet
- Present options warmly, ask what resonates, offer to dig deeper.
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
});

type GoalIntent = z.infer<typeof GoalIntentSchema>;

async function extractIntent(
  history: ChatMessage[],
  userMessage: string
): Promise<GoalIntent> {
  // Only pass last 4 turns to keep this call cheap
  const nonSystemHistory = history.filter((m) => m.role !== "system").slice(-4);

  const prompt: ChatMessage[] = [
    {
      role: "system",
      content: `You are an intent detection and goal-decomposition engine for a travel and retail deals assistant.

## Intent detection (pick ONE)
- "travel_booking": user wants to book flights, hotels, car rentals, activities, or plan a trip.
- "retail_shopping": user wants to buy a product.
- "product_comparison": user is comparing options.
- "general_question": travel or shopping question with no purchase intent — set categories to [].
- "dashboard": user asks about earnings, cashback, commissions. Set is_dashboard_query: true.
- "off_topic": nothing to do with travel or shopping. Set is_off_topic: true.

## purchase_ready detection
Set purchase_ready: true ONLY if the user explicitly signals they want to proceed NOW:
- "book this", "I'll go with", "I want to buy", "send me the link", "get me the link", "which one should I get", "how do I book", "let's do it", "I'm ready"
- Asking to compare two specific named options also counts (they're close to deciding)
Set purchase_ready: false if they're still exploring, asking "what's good", or haven't picked anything.

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
  "purchase_ready": bool
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
}

async function runTools(
  intent: GoalIntent,
  walletAddress: string,
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
    intent.categories.map(async (cat) => {
      const platforms = platformsForCategory(cat.label, cat.platform_search);
      const isHotel = HOTEL_RE.test(cat.label);
      console.log(`[agent] category "${cat.label}" isHotel=${isHotel} — trying platforms:`, platforms);

      // For hotels: always mint BOTH trip-com and agoda in parallel
      if (isHotel) {
        const [tripResult, agodaResult] = await Promise.allSettled([
          resolveMerchant("trip-com", intent.geo),
          resolveMerchant("agoda", intent.geo),
        ]);

        const trip = tripResult.status === "fulfilled" ? tripResult.value : null;
        const agoda = agodaResult.status === "fulfilled" ? agodaResult.value : null;

        if (!trip && !agoda) throw new Error(`No hotel merchants available for ${cat.label}`);

        // Primary = trip-com, extra = agoda (or swap if trip-com failed)
        const primary = trip ?? agoda!;
        const extra = trip && agoda ? agoda : null;

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

  let totalCashback = 0;
  let anyEstimate = false;
  const cashbackBreakdown: string[] = [];

  for (const cat of intent.categories.slice(0, 4)) {
    const emoji = emojiFor(cat.label);
    const matched = enrichedByLabel.get(cat.label);

    lines.push(`${emoji} *${cat.label}*`);

    // Show all 3 recommendations as a numbered list
    const recs = cat.recommendations.slice(0, 3);
    recs.forEach((rec, i) => {
      lines.push(`${i + 1}. ${rec}`);
    });

    if (matched) {
      const primaryName = matched.info?.name ?? cat.label;
      const primaryRate = extractRate(matched.info);
      const rateStr = (r: ReturnType<typeof extractRate>) => r ? ` · ${(r.rate * 100).toFixed(0)}% rebate` : "";

      // Build booking line(s) — primary platform
      if (matched.link?.shortlink) {
        lines.push(`→ Book on *${primaryName}*${rateStr(primaryRate)}: ${matched.link.shortlink}`);
      } else if (matched.acpJob) {
        lines.push(`→ *${primaryName}*${rateStr(primaryRate)} — _link coming shortly_ ⏳`);
      } else {
        lines.push(`→ via *${primaryName}*${rateStr(primaryRate)}`);
      }

      // Extra platforms (hotel: agoda alongside trip-com)
      if (matched.extraPlatforms) {
        for (const ep of matched.extraPlatforms) {
          const epRate = extractRate(ep.info);
          if (ep.link?.shortlink) {
            lines.push(`→ Book on *${ep.name}*${rateStr(epRate)}: ${ep.link.shortlink}`);
          } else if (ep.acpJob) {
            lines.push(`→ *${ep.name}*${rateStr(epRate)} — _link coming shortly_ ⏳`);
          }
        }
      }

      // Cashback calc on primary
      if (primaryRate) {
        const pick = recs[0] ?? "";
        const price = extractPrice(pick);
        if (price) {
          const cashback = price * primaryRate.rate;
          totalCashback += cashback;
          if (primaryRate.isEstimate) anyEstimate = true;
          cashbackBreakdown.push(`${primaryName} ${(primaryRate.rate * 100).toFixed(0)}% × $${price} = $${cashback.toFixed(2)}`);
        }
      }
    } else {
      lines.push(`→ via ${cat.platform_search}`);
    }

    lines.push(""); // blank line between categories
  }

  if (purchaseReady) {
    // Show cashback footer only when minting links
    if (totalCashback > 0.005) {
      const estLabel = anyEstimate ? "est. " : "";
      lines.push(
        `_Book through these links and receive ${estLabel}*$${totalCashback.toFixed(2)} USDC* in rebate 💸_\n` +
        `_↳ ${cashbackBreakdown.join(" · ")}_`
      );
    } else {
      const rateItems = enriched
        .filter((e) => e.acpJob || e.link?.shortlink)
        .map((e) => {
          const r = extractRate(e.info);
          return r ? `${e.info?.name ?? e.label} (${(r.rate * 100).toFixed(0)}%)` : null;
        })
        .filter(Boolean)
        .slice(0, 3);
      if (rateItems.length > 0) {
        lines.push(`_Book through these links and earn USDC rebates — ${rateItems.join(", ")} 💸_`);
      }
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
      console.error("[agent] ⏱ pipeline timed out after 30s");
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
      const enriched = await runTools(intent, walletAddress, purchaseReady);
      reply = buildReply(intent, enriched, !!walletAddress, userCountry, purchaseReady);

      // For each ACP job in flight, send follow-up when it settles
      if (onFollowUp) {
        const sendFollowUp = (job: Promise<MintedLink>, name: string, info: MerchantInfo) => {
          job.then((minted) => {
            console.log(`[acp] ✅ follow-up link ready for ${name}:`, minted.shortlink);
            const rateInfo = extractRate(info);
            const rateStr = rateInfo ? ` · earn *${(rateInfo.rate * 100).toFixed(0)}% rebate*` : "";
            return onFollowUp(`🔗 *${name}*${rateStr}\n${minted.shortlink}`);
          }).catch((err) => {
            console.error(`[acp] follow-up failed for ${name}:`, err instanceof Error ? err.message : err);
          });
        };

        for (const cat of enriched) {
          if (cat.acpJob) sendFollowUp(cat.acpJob, cat.info?.name ?? cat.label, cat.info);
          for (const ep of cat.extraPlatforms ?? []) {
            if (ep.acpJob) sendFollowUp(ep.acpJob, ep.name, ep.info);
          }
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
