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

const SYSTEM_PROMPT = `/no_think
You are Nexus, a personal travel and shopping concierge on Telegram.

## Cardinal rule: BREVITY
This is a mobile chat interface. Users scroll fast and lose interest in long messages.
- Hard limit: 180 words per reply.
- Max 4 categories per response. Pick the most important ones.
- Each category: 1 specific recommendation + 1 platform link. That's it.
- No intros, no filler, no "Great choice!". Get straight to the picks.

## Tone
- Confident and specific: "The Layar Villa in Seminyak, ~$150/night" not "there are some nice hotels".
- Like a well-travelled friend texting you their honest picks.
- Cashback is a PS at the end, never the headline.

## Format (stick to this exactly)
[one-line goal confirm]

✈️ *Flights* — [specific route/airline, price hint]
→ Book on [Platform]: [link or "ask me for the link"]

🏨 *Hotels* — [specific property, neighbourhood, price]
→ Book on [Platform]: [link or "ask me for the link"]

[repeat for up to 4 categories]

_Book via these links and save a little too 💸_

## Rules
- ONLY use affiliate links from tool results — never fabricate URLs.
- If no link: name the platform and say "reply 'link' and I'll grab it".
- Never say "no results". Always give a real pick.
- 180 words max. Every word earns its place.`;

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
  categories: z.array(CategorySchema).min(1).max(6),
  /** ISO 3166-1 alpha-2 if a country/region is mentioned */
  geo: z.string().length(2).optional(),
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
      content: `You are a goal-decomposition and recommendation engine for a travel and retail concierge.

Given the user's message, output ONLY valid JSON:
{
  "goal": string,
  "categories": [
    {
      "label": string,              // e.g. "Flights", "Hotels", "Running Shoes", "Supplements"
      "recommendations": [string],  // 2–3 SPECIFIC items: hotel names, product names, brands, routes
      "platform_search": string,    // specific platform to search: "agoda", "trip.com", "klook", "nike", "iherb", "zalora", "asos"
      "category": string            // one of: travel, fashion, electronics, health, retail
    }
  ],
  "geo": string|null,
  "is_dashboard_query": bool,
  "is_off_topic": bool
}

## Recommendation rules
Be SPECIFIC. Use real names the user will recognise:
- Hotels: actual property names + neighbourhood + rough price, e.g. "The Layar Villa, Seminyak (~$150/night)"
- Flights: route + airline, e.g. "AirAsia direct KUL→DPS (from ~$80)"
- Activities: named tours, e.g. "Ubud Rice Terrace & Monkey Forest half-day (Klook, ~$25)"
- Running shoes: model names, e.g. "Nike Pegasus 41", "Adidas Ultraboost 24"
- Supplements: brand + product, e.g. "Optimum Nutrition Gold Standard Whey", "NOW Foods Vitamin C"
- Fashion: brand + item, e.g. "Uniqlo AIRism T-shirt", "Levi's 511 slim jeans"

## Platform search rules (platform_search field)
Search specific platform names — NOT generic terms:
- Flights: "airasia", "trip.com"
- Hotels: "agoda", "booking.com", "trip.com"
- Activities: "klook"
- Fashion: "zalora", "asos", "nike", "adidas", "uniqlo"
- Health/supplements: "iherb"
- Electronics: "samsung", "lenovo", "dyson"
- General: "lazada", "amazon"

Max 6 categories. No explanation — only the JSON object.`,
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
    if (result.status !== "fulfilled") continue;
    const { cat, merchants } = result.value;
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
      return { label, recommendations, info, link } satisfies EnrichedCategory;
    })
  );

  return enriched
    .filter(
      (r): r is PromiseFulfilledResult<EnrichedCategory> =>
        r.status === "fulfilled"
    )
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

  const unmatchedBlock = intent.categories
    .filter((cat) => !enrichedLabels.has(cat.label))
    .map(
      (cat) =>
        `[${cat.label}]\n` +
        `Recommendations: ${cat.recommendations.join(" | ")}\n` +
        `Platform to suggest: ${cat.platform_search} (no affiliate link yet — name the platform and offer to get a deal link)`
    )
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

Write a Telegram reply following the system prompt format EXACTLY.
- 180 words MAX — cut ruthlessly.
- Pick the top 3–4 categories only.
- One specific pick per category, then the platform + link on the next line.
- No fluff, no long intros, no "Great question!".
- Cashback as a one-line PS at the very end.`,
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
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.filter((m) => m.role !== "system"),
      ];
      reply = await chat(messages);
    } else if (intent.is_dashboard_query) {
      reply = "Use /dashboard to check your savings and cashback history.";
    } else {
      const enriched = await runTools(intent, walletAddress);
      reply = await composeResponse(history, text, intent, enriched);
    }

    history.push({ role: "assistant", content: reply });

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
