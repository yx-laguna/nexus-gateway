/**
 * agent.ts
 *
 * Core shopping agent logic.
 *
 * Two-step reasoning pipeline:
 *
 *   Step 1 — Intent extraction (DeepSeek V3 → structured JSON)
 *     DeepSeek reads the conversation and outputs a ShoppingIntent object that
 *     describes what the user wants to buy, the preferred category, country,
 *     and any budget constraints.
 *
 *   Step 2 — Tool execution (Node → Laguna MCP)
 *     The intent drives direct calls to Laguna's affiliate tools:
 *       • search_merchants  – find relevant merchants
 *       • get_merchant_info – fetch cashback rates for top picks
 *       • mint_link         – generate tracked shortlinks per merchant
 *
 *   Step 3 — Response composition (DeepSeek V3 → Markdown reply)
 *     DeepSeek receives the raw tool results and writes a friendly, ranked
 *     reply with links and USDC cashback figures.
 */

import { chat, type ChatMessage } from "./broker.js";
import {
  searchMerchants,
  getMerchantInfo,
  mintLink,
  type Merchant,
  type MerchantInfo,
  type MintedLink,
} from "./laguna.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Session store  (in-memory; replace with Redis/DB for production)
// ---------------------------------------------------------------------------

const sessions = new Map<number, ChatMessage[]>();

const SYSTEM_PROMPT = `You are Nexus, an expert AI shopping assistant.
Your goal is to find the best online merchants, cashback deals, and affiliate offers for users.
Be concise, friendly, and always highlight cashback/USDC earnings prominently.
When you have merchant data and links, present them in a clear ranked list.`;

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
// Step 1 — Intent extraction
// ---------------------------------------------------------------------------

const ShoppingIntentSchema = z.object({
  /** Plain-English shopping query, e.g. "wireless headphones under $100" */
  query: z.string(),
  /** Optional merchant category: "electronics", "fashion", "travel", etc. */
  category: z.string().optional(),
  /** ISO 3166-1 alpha-2 country code the user is shopping from */
  geo: z.string().length(2).optional(),
  /** Maximum budget in USD if mentioned */
  budget_usd: z.number().optional(),
  /** Whether the user is asking for account/earnings info rather than shopping */
  is_dashboard_query: z.boolean().default(false),
  /** true if the message has no shopping intent (greeting, off-topic, etc.) */
  is_off_topic: z.boolean().default(false),
});

type ShoppingIntent = z.infer<typeof ShoppingIntentSchema>;

async function extractIntent(
  history: ChatMessage[],
  userMessage: string
): Promise<ShoppingIntent> {
  const extractionPrompt: ChatMessage[] = [
    {
      role: "system",
      content: `You are an intent-extraction engine.
Given the conversation and the latest user message, output ONLY valid JSON matching this schema:
{
  "query": string,           // what the user wants to buy/find
  "category": string|null,   // merchant category if clear
  "geo": string|null,        // 2-letter country code if mentioned
  "budget_usd": number|null, // numeric budget if mentioned
  "is_dashboard_query": bool,// true if user asks about earnings/balance/history
  "is_off_topic": bool       // true if not a shopping request
}
Do not include any explanation — only the JSON object.`,
    },
    // Include last 6 turns of history for context
    ...history.slice(-6),
    { role: "user", content: userMessage },
  ];

  const raw = await chat(extractionPrompt, true);

  try {
    return ShoppingIntentSchema.parse(JSON.parse(raw));
  } catch {
    // Fallback: treat whole message as query
    return {
      query: userMessage,
      is_dashboard_query: false,
      is_off_topic: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Tool execution
// ---------------------------------------------------------------------------

interface ToolResults {
  merchants: Array<{
    info: MerchantInfo;
    link: MintedLink;
  }>;
  searchCount: number;
}

async function runTools(intent: ShoppingIntent, walletAddress: string): Promise<ToolResults> {
  // 1. Search merchants
  const found = await searchMerchants({
    query: intent.query,
    category: intent.category,
    geo: intent.geo,
    limit: 5,
    sort: intent.query ? "relevance" : "cashback_rate",
  });

  // 2. Fetch detailed info + mint links for top 3 merchants in parallel
  const top: Merchant[] = found.slice(0, 3);

  const enriched = await Promise.allSettled(
    top.map(async (m) => {
      const [info, link] = await Promise.all([
        getMerchantInfo({ merchant_id: m.id, geo: intent.geo }),
        // Mint link credited to this specific user's wallet
        mintLink({ merchant_id: m.id, geo: intent.geo, wallet_address: walletAddress }),
      ]);
      return { info, link };
    })
  );

  const merchants = enriched
    .filter(
      (r): r is PromiseFulfilledResult<{ info: MerchantInfo; link: MintedLink }> =>
        r.status === "fulfilled"
    )
    .map((r) => r.value);

  return { merchants, searchCount: found.length };
}

// ---------------------------------------------------------------------------
// Step 3 — Response composition
// ---------------------------------------------------------------------------

async function composeResponse(
  history: ChatMessage[],
  userMessage: string,
  intent: ShoppingIntent,
  tools: ToolResults
): Promise<string> {
  const toolSummary =
    tools.merchants.length > 0
      ? tools.merchants
          .map((m, i) => {
            const cashback =
              m.info.cashback_rate ?? m.info.rates?.[0] ?? "varies";
            return (
              `${i + 1}. ${m.info.name} (${m.info.category ?? intent.category ?? "general"})` +
              `\n   Cashback: ${cashback}` +
              `\n   Link: ${m.link.shortlink}` +
              (m.info.cookie_duration
                ? `\n   Cookie: ${m.info.cookie_duration}`
                : "") +
              (m.info.payout_timeline
                ? `\n   Payout: ${m.info.payout_timeline}`
                : "")
            );
          })
          .join("\n\n")
      : "No merchants found for this query.";

  const compositionMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-4),
    {
      role: "user",
      content: `User asked: "${userMessage}"\n\nSearch returned ${tools.searchCount} merchants. Top picks with affiliate links:\n\n${toolSummary}\n\nWrite a friendly Telegram reply (Markdown OK). Highlight USDC cashback earnings. Keep it under 400 words.`,
    },
  ];

  return chat(compositionMessages);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process a user message end-to-end and return the bot reply.
 *
 * @param userId  Telegram user ID (used to key the session)
 * @param text    Raw user message text
 */
export async function processMessage(
  userId: number,
  text: string,
  walletAddress: string
): Promise<string> {
  const history = getHistory(userId);

  // Append user turn to history before processing
  history.push({ role: "user", content: text });

  try {
    // Step 1 — extract structured intent
    const intent = await extractIntent(history, text);

    let reply: string;

    if (intent.is_off_topic) {
      // Pass through to DeepSeek for a general response
      reply = await chat(history);
    } else if (intent.is_dashboard_query) {
      // Handled separately in bot.ts via /dashboard command,
      // but if user asks mid-conversation we can handle it here too
      reply =
        "Use /dashboard to see your current USDC balance and conversion history.";
    } else {
      // Step 2 — call Laguna tools (links credited to this user's wallet)
      const tools = await runTools(intent, walletAddress);

      // Step 3 — compose reply
      reply = await composeResponse(history, text, intent, tools);
    }

    // Append assistant turn to history
    history.push({ role: "assistant", content: reply });

    // Cap history at 20 turns (10 exchanges) to control context size
    if (history.length > 21) {
      // Keep system prompt + last 20 turns
      history.splice(1, history.length - 21);
    }

    return reply;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[agent] error processing message:", msg);
    // Don't store error turns in history
    history.pop();
    throw err;
  }
}
