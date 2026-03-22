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

const SYSTEM_PROMPT = `You are Nexus, a travel and shopping concierge on Telegram — powered by Laguna's affiliate network.

## Your Role
Shopping/travel assistant FIRST. Cashback is a bonus you offer, not your primary purpose.
Always answer the user's actual question fully before mentioning cashback or links.

## Conversation Mode (default)
- Chat naturally. One question at a time. Never interrogate.
- Do NOT jump to a full plan until the user's goal is clear.
- Travel needs: destination + rough dates. Shopping needs: item + rough budget/preference.
- If something critical is missing, ask for ONE thing only.

## Cashback Awareness Protocol (run silently when composing a plan)
When you mention a specific brand, store, or booking platform:
1. Check if it's on Laguna via search_merchants
2. If found, get the rate via get_merchant_info
3. Mint a tracked link via mint_link using the user's wallet
4. Weave the link in naturally — never as the headline

## Identity
- User wallet: injected per-user. Ask ONCE if not set: "Want me to track cashback for you? Drop your EVM wallet address."
- User country: ask once at a natural moment for geo-filtered rates.

## Response Format (only when goal is clear)
[one-line confirm of what you're planning]

[emoji] *[Category]* — [specific pick + price hint]
→ [Platform]: [affiliate link or real platform URL]

[up to 4 categories max]

_Book through these links and save a little too 💸_
PS: [one cashback line only — rate from tool result, never guessed]

## Rules
- ANSWER the question first. Cashback nudge comes after.
- NEVER fabricate URLs. Affiliate links from tool results only. No link? Use real homepage.
- NEVER force a Laguna link when the merchant isn't on the platform — still recommend the best product.
- NEVER state a cashback rate unless get_merchant_info confirmed it.
- 150 words MAX per reply. Telegram screen is small — be sharp.
- Cashback is the PS, never the headline.
- If off-topic: "I'm best at travel and shopping — what are you planning?"`;



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
- Flights → "airasia" or "trip.com"
- Hotels → "agoda" or "trip.com" or "hotels.com"
- Activities/Tours → "klook" or "kkday"
- Fashion/Apparel → "shein" or "asos" or "farfetch" or "cotton on"
- Health/Supplements → "iherb"
- Gifts/General → "temu"
- Luxury Hotels → "hyatt" or "ihg" or "dusit"

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
  // Search all platforms in parallel
  const searchResults = await Promise.allSettled(
    intent.categories.map(async (cat) => {
      const found = await searchMerchants({
        query: cat.platform_search,
        // category filter omitted — Laguna does not use category slugs
        geo: intent.geo,
        limit: 2,
        sort: "relevance",
      });
      return { cat, merchants: found };
    })
  );

  // Deduplicate by merchant id, keep best match per category
  const seen = new Set<string>();
  const candidates: Array<{
    label: string;
    recommendations: string[];
    merchantId: string;
    geo?: string;
  }> = [];

  for (const result of searchResults) {
    if (result.status !== "fulfilled") {
      console.error("[agent] merchant search failed:", result.reason);
      continue;
    }
    const { cat, merchants } = result.value;
    console.log(`[agent] search "${cat.platform_search}" → ${merchants.length} result(s):`, merchants.map((m) => m.id));
    for (const m of merchants.slice(0, 1)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      candidates.push({
        label: cat.label,
        recommendations: cat.recommendations,
        merchantId: m.id,
        geo: intent.geo,
      });
    }
  }

  // Fetch info + mint affiliate links in parallel
  const enriched = await Promise.allSettled(
    candidates.map(async ({ label, recommendations, merchantId, geo }) => {
      const [info, link] = await Promise.all([
        getMerchantInfo({ merchant_id: merchantId, geo }),
        mintLink({ merchant_id: merchantId, geo, wallet_address: walletAddress }),
      ]);
      console.log(`[agent] minted link for ${merchantId}:`, link.shortlink);
      return { label, recommendations, info, link } satisfies EnrichedCategory;
    })
  );

  return enriched
    .filter((r): r is PromiseFulfilledResult<EnrichedCategory> => {
      if (r.status !== "fulfilled") {
        console.error("[agent] mint/info failed:", (r as PromiseRejectedResult).reason);
      }
      return r.status === "fulfilled";
    })
    .map((r) => r.value);
}

// ---------------------------------------------------------------------------
// Step 3 — Pure Node.js response formatter (no LLM — no hallucinated URLs)
// ---------------------------------------------------------------------------

const FALLBACK_URLS: Record<string, string> = {
  agoda:    "https://agoda.com",
  trip:     "https://trip.com",
  airasia:  "https://airasia.com",
  klook:    "https://klook.com",
  kkday:    "https://kkday.com",
  hotels:   "https://hotels.com",
  hyatt:    "https://hyatt.com",
  ihg:      "https://ihg.com",
  dusit:    "https://dusithotels.com",
  shein:    "https://shein.com",
  asos:     "https://asos.com",
  farfetch: "https://farfetch.com",
  cotton:   "https://cottonon.com",
  iherb:    "https://iherb.com",
  temu:     "https://temu.com",
  nike:     "https://nike.com",
  adidas:   "https://adidas.com",
};

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

function fallbackUrl(platformSearch: string): string {
  const key = platformSearch.toLowerCase();
  return (
    Object.entries(FALLBACK_URLS).find(([k]) => key.includes(k))?.[1]
    ?? `https://${key.replace(/[^a-z0-9]/g, "")}.com`
  );
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
      const name = matched.info?.name ?? cat.platform_search;
      lines.push(`→ Book on ${name}: ${matched.link.shortlink}`);
    } else {
      const url = fallbackUrl(cat.platform_search);
      lines.push(`→ Book on ${cat.platform_search}: ${url}`);
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

    const isActionable =
      (intent.intent === "travel_booking" || intent.intent === "retail_shopping" || intent.intent === "product_comparison") &&
      !intent.needs_clarification &&
      intent.categories.length > 0;

    if (intent.is_dashboard_query) {
      reply = "Use /dashboard to check your affiliate earnings and cashback history.";

    } else if (intent.is_off_topic) {
      // Let the model respond naturally and steer back
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);

    } else if (!isActionable) {
      // General chat, missing info, or unclear intent — keep the conversation going
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);

    } else {
      // Intent is clear and complete — call Laguna, mint links, present plan
      console.log(`[agent] intent confirmed: ${intent.intent} | ${intent.categories.map(c => c.label).join(", ")}`);
      // Use profile country as geo if intent didn't detect one from the message
      if (!intent.geo && userCountry) intent.geo = userCountry;
      const enriched = await runTools(intent, walletAddress);
      reply = buildReply(intent, enriched, !!walletAddress, userCountry);
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
