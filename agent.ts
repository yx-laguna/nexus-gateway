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
  mintLink,
  type MerchantInfo,
  type MintedLink,
} from "./laguna.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessions = new Map<number, ChatMessage[]>();

// ---------------------------------------------------------------------------
// System prompt — concierge-first, USDC as a footnote
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Opi, a friendly travel and shopping concierge on Telegram.

## Your job in conversation
- Chat naturally. Help the user figure out what they want.
- ONE question at a time. Never interrogate.
- Travel: you need destination + rough dates before acting.
- Shopping: you need the item/category + rough budget or preference.
- If something critical is missing, ask for the ONE most important thing.

## What you NEVER do in conversation
- NEVER produce URLs, links, or platform names with addresses.
- NEVER mention cashback rates — you don't have live data in conversation mode.
- NEVER say "I'll send you a tracked link" or ask for a wallet address — the system handles that.
- NEVER list platforms (Trip.com, Booking.com, Klook etc.) with prices or rates you made up.

## When the goal IS clear
- Confirm the goal in one friendly sentence.
- Say "Let me find the best options for you!" and stop — the system will fetch real merchant links automatically.
- Do NOT list hotels, flights, or products yourself — the system does that with real data.

## Off-topic
"I'm best at travel and shopping — what are you planning?"

## Tone
Warm, concise, like a knowledgeable friend. Max 3 sentences in conversation mode.`;



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
  /** Specific platform name to search in Laguna — must match verified slugs */
  platform_search: z.string(),
});

const GoalIntentSchema = z.object({
  goal: z.string(),
  intent: z.enum(["travel_booking", "retail_shopping", "product_comparison", "general_question", "dashboard", "off_topic"]).default("general_question"),
  categories: z.array(CategorySchema).default([]),
  geo: z.string().length(2).optional(),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().optional(),
  is_dashboard_query: z.boolean().default(false),
  is_off_topic: z.boolean().default(false),
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
      content: `You are an intent detection and goal-decomposition engine for a travel and retail concierge.

## Intent detection (pick ONE)
- "travel_booking": user wants to book flights, hotels, car rentals, activities, or plan a trip. Triggers: "book", "fly to", "stay in", "hotel in", "trip to", "visit", "vacation", "holiday", destination names.
- "retail_shopping": user wants to buy a product. Triggers: "buy", "shop for", "get me", "looking for" + item.
- "product_comparison": user is comparing options. Triggers: "compare", "which is better", "vs", "difference between".
- "general_question": travel or shopping question with no purchase intent. Answer conversationally — set categories to [].
- "dashboard": user asks about their earnings, cashback, commissions. Set is_dashboard_query: true.
- "off_topic": nothing to do with travel or shopping. Set is_off_topic: true.

If multiple intents, choose the most explicit one. If unclear, treat as "general_question".

## Output — ONLY valid JSON, no explanation:
{
  "goal": string,
  "intent": "travel_booking" | "retail_shopping" | "product_comparison" | "general_question" | "dashboard" | "off_topic",
  "categories": [
    {
      "label": string,              // e.g. "Flights", "Hotels", "Running Shoes", "Supplements"
      "recommendations": [string],  // 2–3 SPECIFIC items with real names + price hints
      "platform_search": string     // exact platform slug from the verified list below
    }
  ],
  "geo": string|null,               // ISO 3166-1 alpha-2 if a country/region is mentioned
  "needs_clarification": bool,      // true if critical info is missing (destination, dates, budget)
  "clarification_question": string, // ONE question to ask if needs_clarification is true
  "is_dashboard_query": bool,
  "is_off_topic": bool
}

## Recommendation rules — be SPECIFIC:
- Hotels: real property names + neighbourhood + price, e.g. "Pullman Jakarta Central Park, Thamrin (~$120/night)"
- Flights: airline + route, e.g. "Garuda Indonesia CGK→NBO (from ~$650 return)"
- Activities: named tours + platform, e.g. "Bali Swing & Ubud Tour via Klook (~$35)"
- Running shoes: model names, e.g. "Nike Pegasus 41", "Adidas Ultraboost 24"
- Supplements: brand + product, e.g. "Optimum Nutrition Gold Standard Whey"
- Fashion: brand + item, e.g. "Uniqlo AIRism T-shirt", "Levi's 511 slim jeans"

## Platform search slugs (use EXACTLY these):
- Flights → "trip" or "airasia" or "airalo"
- Hotels → "trip" or "agoda" or "booking"
- Activities/Tours → "klook" or "kkday" or "trip"
- Fashion/Apparel → "nike" or "shein" or "asos" or "crocs"
- Health/Supplements → "iherb"
- Electronics → "lenovo" or "samsung"
- Gifts/General → "temu" or "shein"
- Luxury Hotels → "trip" or "ihg"

Max 4 categories. Output JSON only.`,
    },
    ...nonSystemHistory.slice(-6),
    { role: "user", content: userMessage },
  ];

  const raw = await chat(prompt, true);

  try {
    return GoalIntentSchema.parse(JSON.parse(raw));
  } catch {
    // Safe fallback — treat as a general question, never fabricate a search
    console.warn("[agent] intent parse failed, falling back to general_question. Raw:", raw.slice(0, 200));
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

export interface EnrichedCategory {
  label: string;
  recommendations: string[];
  info: MerchantInfo;
  link: MintedLink;
}

async function runTools(
  intent: GoalIntent,
  walletAddress: string
): Promise<EnrichedCategory[]> {
  // For each category label, an ordered list of platform slugs to try.
  // We try each in sequence until one is available AND mintable.
  const CATEGORY_PLATFORMS: Record<string, string[]> = {
    flights:     ["trip", "airasia", "airalo"],
    flight:      ["trip", "airasia", "airalo"],
    hotels:      ["trip", "agoda", "booking"],
    hotel:       ["trip", "agoda", "booking"],
    activities:  ["klook", "kkday", "trip"],
    activity:    ["klook", "kkday", "trip"],
    tours:       ["klook", "kkday", "trip"],
    fashion:     ["nike", "shein", "asos", "crocs"],
    apparel:     ["nike", "shein", "asos", "crocs"],
    shopping:    ["shein", "temu", "nike"],
    supplements: ["iherb"],
    health:      ["iherb"],
    electronics: ["lenovo"],
    sports:      ["nike", "adidas", "crocs"],
  };

  function platformsForCategory(label: string, primary: string): string[] {
    const key = label.toLowerCase();
    const defaults =
      Object.entries(CATEGORY_PLATFORMS).find(([k]) => key.includes(k))?.[1] ?? [];
    // Always try the LLM-chosen platform first, then the category defaults (deduped)
    return [primary, ...defaults.filter((p) => p !== primary)];
  }

  // Deduplicate minted merchants across categories
  const mintedMerchants = new Set<string>();

  // Per-category: try platforms in order until one mint succeeds
  const categoryResults = await Promise.allSettled(
    intent.categories.map(async (cat) => {
      const platforms = platformsForCategory(cat.label, cat.platform_search);
      console.log(`[agent] category "${cat.label}" — trying platforms:`, platforms);

      for (const platform of platforms) {
        // Search Laguna for this platform
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

        // Try each merchant returned for this platform
        for (const merchant of merchants) {
          if (mintedMerchants.has(merchant.id)) continue;

          // Check availability
          const info = await getMerchantInfo({ merchant_id: merchant.id, geo: intent.geo });
          if (!info || (info as { available?: boolean }).available === false) {
            console.warn(`[agent] ⚠️ ${merchant.id} not available — trying next`);
            continue;
          }

          // No wallet → return info only (no link)
          if (!walletAddress) {
            mintedMerchants.add(merchant.id);
            return {
              label: cat.label,
              recommendations: cat.recommendations,
              info,
              link: { shortlink: "", merchant_id: merchant.id },
            } satisfies EnrichedCategory;
          }

          // Mint affiliate link
          const link = await mintLink({
            merchant_id: merchant.id,
            geo: intent.geo,
            wallet_address: walletAddress,
          });

          if (!link?.shortlink) {
            console.warn(`[agent] ⚠️ ${merchant.id} mint returned no shortlink — trying next`);
            continue;
          }

          mintedMerchants.add(merchant.id);
          console.log(`[agent] ✅ minted ${merchant.id} for "${cat.label}":`, link.shortlink);
          return { label: cat.label, recommendations: cat.recommendations, info, link } satisfies EnrichedCategory;
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

function buildReply(
  intent: GoalIntent,
  enriched: EnrichedCategory[],
  hasWallet: boolean,
  userCountry?: string
): string {
  const enrichedByLabel = new Map(enriched.map((e) => [e.label, e]));
  const lines: string[] = [];

  // Opening confirm line
  lines.push(`On it — here's your plan for *${intent.goal}*.\n`);

  // One block per category
  for (const cat of intent.categories.slice(0, 4)) {
    const emoji = emojiFor(cat.label);
    const pick = cat.recommendations[0] ?? cat.label;
    const matched = enrichedByLabel.get(cat.label);

    lines.push(`${emoji} *${cat.label}* — ${pick}`);

    if (matched?.link?.shortlink) {
      // Laguna-minted affiliate link — the only kind we show
      const name = matched.info?.name ?? cat.platform_search;
      lines.push(`→ Book on ${name}: ${matched.link.shortlink}`);
    } else if (matched) {
      // Merchant found but no shortlink (no wallet set or mint failed)
      const name = matched.info?.name ?? cat.platform_search;
      lines.push(`→ via ${name} _(set your wallet to get a cashback link)_`);
    } else {
      // No merchant found in Laguna for this category
      lines.push(`→ via ${cat.platform_search} _(not yet on our affiliate network)_`);
    }

    lines.push(""); // blank line between categories
  }

  lines.push("_Book through these links and save a little too 💸_");

  // PS cashback — only if we have a confirmed rate from tool results
  const cashbackItems = enriched
    .filter((e) => e.info?.cashback_rate)
    .map((e) => `${e.info.name} (${e.info.cashback_rate} cashback)`)
    .slice(0, 2);

  if (cashbackItems.length > 0) {
    lines.push(`PS: Earn USDC cashback via ${cashbackItems.join(", ")}.`);
  }

  // Country reminder — shown when geo was used so user knows to update if needed
  if (userCountry) {
    lines.push(`\n_Links are curated for *${userCountry}*. Shopping from somewhere else? Just let me know or update with \`/setcountry\`._`);
  }

  // Wallet nudge — only shown when no wallet is set yet
  if (!hasWallet) {
    lines.push(
      `\n💳 *Want to earn cashback on these?*\nSave your EVM wallet and I'll track your USDC commissions:\n\`/setwallet 0xYourAddress\``
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
  walletAddress: string,   // empty string means no wallet set yet
  userCountry?: string     // ISO alpha-2, e.g. "SG" — from user profile
): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: text });

  try {
    // Skip intent extraction for short casual messages — saves an LLM call
    const isCasual = text.trim().split(/\s+/).length <= 4 && !/hotel|flight|book|buy|shop|trip|travel|order|plan|stay|rent/i.test(text);

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
      // We have enough to search merchants — always run tools even if dates missing
      console.log(`[agent] running tools: ${intent.intent} | ${intent.categories.map(c => c.label).join(", ")} | geo: ${intent.geo ?? userCountry ?? "none"}`);
      if (!intent.geo && userCountry) intent.geo = userCountry;
      const enriched = await runTools(intent, walletAddress);
      reply = buildReply(intent, enriched, !!walletAddress, userCountry);

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
