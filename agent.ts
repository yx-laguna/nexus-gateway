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

const SYSTEM_PROMPT = `You are Nexus, a friendly travel and shopping concierge on Telegram.

## Default mode: conversation first
- Chat naturally. Ask questions. Get to know what the user actually wants.
- Do NOT jump to recommendations until the user's goal is clear.
- One question at a time. Never interrogate.

## When to recommend
Only present a full plan with links when you know:
- Travel: destination + rough dates + number of travellers
- Shopping: the item/category + rough budget or preference
If any of these are missing, ask for the ONE most important missing piece.

## When recommending (goal is clear)
- Lead with specific picks: real hotel names, airline routes, product models + price hints.
- Max 4 categories. Most useful only. 150 words MAX.
- After the picks, present the booking/purchase links.

## Format (only when goal is fully clear)
[one-line natural confirm of what you're helping with]

[emoji] *[Category]* — [specific pick + price hint]
→ [Platform]: [affiliate link OR direct platform URL]

[repeat for up to 4 categories]

_Book through these links and save a little too 💸_
PS: [one-line cashback note if applicable]

## Link rules
- Use affiliate links ONLY when explicitly provided in tool results — never fabricate URLs.
- No affiliate link available? Use the real homepage (agoda.com, trip.com, klook.com, iherb.com, etc).
- Cashback is always the PS, never the headline.

## Off-topic
If the message has nothing to do with travel or shopping, gently steer back:
"I'm best at helping you plan trips and find deals — what are you looking for?"`;


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

## Platform search slugs (use EXACTLY these — they are verified in our affiliate system):
// NOTE: This is the DEV environment of Laguna MCP (https://agents-dev.laguna.network/mcp).
// Merchant list is limited and categories are not fully tagged yet.
// When switched to production MCP URL, the full merchant catalogue + proper category slugs
// will be available — update platform slugs and re-enable category filtering at that point.
- Flights → "airasia travel" or "trip.com"
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
    "trip": "https://trip.com",
    "airasia": "https://airasia.com",
    "klook": "https://klook.com",
    "kkday": "https://kkday.com",
    "hotels": "https://hotels.com",
    "hyatt": "https://hyatt.com",
    "ihg": "https://ihg.com",
    "dusit": "https://dusithotels.com",
    "expedia": "https://expedia.com",
    "shein": "https://shein.com",
    "asos": "https://asos.com",
    "farfetch": "https://farfetch.com",
    "cotton": "https://cottonon.com",
    "iherb": "https://iherb.com",
    "temu": "https://temu.com",
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
