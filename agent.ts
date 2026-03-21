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

const SYSTEM_PROMPT = `You are Nexus, a personal travel and shopping concierge on Telegram.

## Your job
Help users plan trips and make purchases. When a user shares a goal (destination, activity, item), break it into actionable steps and recommend specific options — then point them to the right platform to book or buy.

## Conversation style
- If the user is asking a general travel question, answer it naturally and helpfully first.
- If booking intent is clear, move straight to recommendations.
- Ask follow-up questions only if critical info is missing (dates, number of travellers, budget).
- Never ask more than ONE follow-up question at a time.

## When recommending
- Be specific: real hotel names, airline routes, product models — not generic categories.
- Include a rough price hint where possible.
- Max 4 categories per reply. Most relevant ones only.
- 150 words MAX. This is Telegram — keep it tight.

## Format (when making recommendations)
[one-line goal confirm or conversational opener]

[emoji] *[Category]* — [specific pick + price hint]
→ [Platform]: [affiliate link OR direct platform URL]

[repeat for up to 4 categories]

_Book through these links and save a little too 💸_
PS: [one-line cashback note if applicable]

## Link rules
- Use affiliate links ONLY when explicitly provided in tool results — never fabricate.
- If no affiliate link: use the real platform URL (agoda.com, trip.com, klook.com, etc).
- Cashback is always a PS at the end — never the headline.`;

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
  /** Specific platform name to search in Laguna, e.g. "agoda", "trip.com", "klook", "nike" */
  platform_search: z.string(),
  /** Laguna category hint */
  category: z.string().optional(),
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
  const nonSystemHistory = history.filter((m) => m.role !== "system");

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
      "platform_search": string,    // exact platform slug to search: "agoda", "trip.com", "klook", "nike", "iherb", "zalora", "asos", "booking.com", "airasia"
      "category": string            // one of: travel, fashion, electronics, health, retail
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

## Platform search slugs:
- Flights → "airasia", "trip.com"
- Hotels → "agoda", "trip.com", "booking.com"
- Activities → "klook"
- Fashion → "zalora", "asos", "nike", "adidas", "uniqlo"
- Health → "iherb"
- Electronics → "samsung", "lenovo", "dyson"
- General → "lazada", "amazon"

Max 4 categories. Output JSON only.`,
    },
    ...nonSystemHistory.slice(-6),
    { role: "user", content: userMessage },
  ];

  const raw = await chat(prompt, true);

  try {
    return GoalIntentSchema.parse(JSON.parse(raw));
  } catch {
    return {
      goal: userMessage,
      categories: [
        {
          label: "Deals",
          recommendations: [userMessage],
          platform_search: userMessage,
          category: "retail",
        },
      ],
      is_dashboard_query: false,
      is_off_topic: false,
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
        category: cat.category,
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
// Step 3 — Response composition
// ---------------------------------------------------------------------------

async function composeResponse(
  history: ChatMessage[],
  userMessage: string,
  intent: GoalIntent,
  enriched: EnrichedCategory[]
): Promise<string> {
  // Build category blocks — matched (have a link) and unmatched (suggest platform)
  const enrichedLabels = new Set(enriched.map((e) => e.label));

  const matchedBlock = enriched
    .map((e) => {
      const cashback = e.info.cashback_rate ?? e.info.rates?.[0] ?? null;
      return (
        `[${e.label}]\n` +
        `Recommendations: ${e.recommendations.join(" | ")}\n` +
        `Platform: ${e.info.name}${cashback ? ` (${cashback} cashback)` : ""}\n` +
        `Affiliate link: ${e.link.shortlink}`
      );
    })
    .join("\n\n");

  // Build fallback URLs for platforms without affiliate links
  const platformUrls: Record<string, string> = {
    "agoda": "https://agoda.com",
    "booking.com": "https://booking.com",
    "trip.com": "https://trip.com",
    "airasia": "https://airasia.com",
    "skyscanner": "https://skyscanner.com",
    "klook": "https://klook.com",
    "zalora": "https://zalora.com",
    "asos": "https://asos.com",
    "nike": "https://nike.com",
    "adidas": "https://adidas.com",
    "iherb": "https://iherb.com",
    "lazada": "https://lazada.com",
    "amazon": "https://amazon.com",
    "uniqlo": "https://uniqlo.com",
    "sephora": "https://sephora.com",
  };

  const unmatchedBlock = intent.categories
    .filter((cat) => !enrichedLabels.has(cat.label))
    .map((cat) => {
      const key = cat.platform_search.toLowerCase();
      const fallbackUrl = Object.entries(platformUrls).find(([k]) =>
        key.includes(k)
      )?.[1] ?? `https://${key.replace(/\s+/g, "")}.com`;
      return (
        `[${cat.label}]\n` +
        `Recommendations: ${cat.recommendations.join(" | ")}\n` +
        `Platform: ${cat.platform_search} — use this URL directly: ${fallbackUrl}`
      );
    })
    .join("\n\n");

  const compositionMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.filter((m) => m.role !== "system").slice(-4),
    {
      role: "user",
      content: `User's goal: "${userMessage}"
${intent.geo ? `Region: ${intent.geo}` : ""}

== CATEGORIES WITH AFFILIATE LINKS (use these links — do not fabricate) ==
${matchedBlock || "None found."}

== CATEGORIES WITHOUT LINKS YET ==
${unmatchedBlock || "None."}

Write the Telegram reply now. Follow the system prompt format EXACTLY.
- 150 words MAX.
- Top 3–4 categories only.
- One specific pick per category + the URL on the next line.
- Use affiliate links where provided. Use the fallback URL where not. Never ask the user for anything.
- Output the reply only. No reasoning steps, no preamble, no meta-commentary.
- Cashback as one PS line at the very end.`,
    },
  ];

  return chat(compositionMessages);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function processMessage(
  userId: number,
  text: string,
  walletAddress: string
): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: text });

  try {
    const intent = await extractIntent(history, text);

    let reply: string;

    if (intent.is_off_topic) {
      reply = "I'm a travel and shopping concierge — I'm best at helping you plan trips and find deals. What are you looking for?";
    } else if (intent.is_dashboard_query) {
      reply = "Use /dashboard to check your affiliate earnings and cashback history.";
    } else if (intent.needs_clarification && intent.clarification_question) {
      // Missing critical info — ask ONE question before searching
      reply = intent.clarification_question;
    } else if (intent.intent === "general_question" || intent.categories.length === 0) {
      // Conversational travel/shopping question — answer naturally
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);
    } else {
      // Booking or shopping intent — search Laguna + mint links
      const enriched = await runTools(intent, walletAddress);
      reply = await composeResponse(history, text, intent, enriched);
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
