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

## cardinal rule: BREVITY
Mobile chat. Users lose interest fast.
- 150 words MAX. No exceptions.
- Max 4 categories. Pick the most useful ones.
- No intros, no "Great choice!", no filler. Start with the first pick immediately.
- Never show reasoning, analysis, or planning steps. Just the reply.

## Tone
- Specific and confident: "Layar Villa, Seminyak — ~$150/night" not "some nice hotels".
- Like a well-travelled friend texting their honest picks.
- Cashback is a one-line PS at the very end, never the headline.

## Format
[one-line goal confirm]

[emoji] *[Category]* — [specific pick + price hint]
→ [Platform name]: [affiliate link if provided, otherwise direct website URL]

[repeat for up to 4 categories]

_[one-liner about savings] 💸_

## Rules
- Affiliate links: use ONLY links explicitly provided in tool results.
- No affiliate link found: use the platform's real homepage URL (e.g. agoda.com, klook.com). Never ask the user to "reply for a link" — just give the URL.
- Never ask for permission. Never wait. Just recommend and link.
- Never show thinking, analysis steps, or numbered reasoning.
- 150 words max.`;

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
- No thinking, no analysis, no numbered steps — output the reply only.
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

    // Store only the clean reply — never let thinking content pollute history
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
