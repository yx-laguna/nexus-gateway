/**
 * broker.ts
 *
 * Calls Kimi K2 via Virtuals Agent Compute (compute.virtuals.io).
 * OpenAI-compatible endpoint — retry with backoff on 429.
 */

import "dotenv/config";
import OpenAI from "openai";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;

  const apiKey = process.env.VIRTUALS_API_KEY;
  if (!apiKey) throw new Error("VIRTUALS_API_KEY is not set.");

  _client = new OpenAI({
    baseURL: "https://compute.virtuals.io/v1",
    apiKey,
    timeout: 50_000,
    maxRetries: 0,
  });
  console.log("[broker] Virtuals compute client ready → compute.virtuals.io");
  return _client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODEL = "moonshotai-kimi-k2-6";

/**
 * disableThinking (default true): compute.virtuals.io runs Kimi K2 in "thinking" mode
 * by default — it generates a long internal chain-of-thought (returned as
 * `reasoning_content`) before the actual answer. Measured directly against the live
 * endpoint: the SAME 40-candidate hotel-ranking prompt (~6600 prompt tokens) that
 * reliably took 40+ seconds with thinking on completed in ~2.3 seconds with it off,
 * producing an equally well-reasoned, grounded answer either way — thinking mode was
 * pure latency with no quality benefit for our structured-JSON extraction/ranking
 * tasks. This is very likely also what caused the ~36s "cold start" seen on
 * extractIntent() earlier — not a cold start at all, same root cause. Pass
 * disableThinking: false only if a future call genuinely needs visible reasoning.
 */
export async function chat(
  messages: ChatMessage[],
  jsonMode = false,
  retries = 3,
  disableThinking = true
): Promise<string> {
  const client = getClient();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
        venice_parameters?: { disable_thinking: boolean };
      } = {
        model: MODEL,
        messages,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(disableThinking ? { venice_parameters: { disable_thinking: true } } : {}),
      };
      const completion = await client.chat.completions.create(params);
      return completion.choices[0]?.message?.content?.trim() ?? "";
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const isRateLimit = status === 429;
      const isServerError = status !== undefined && status >= 500;
      const isTimeout =
        (err as { code?: string })?.code === "ERR_CANCELLED" ||
        (err instanceof Error && err.message.toLowerCase().includes("timed out"));

      if (!isTimeout && (isRateLimit || isServerError) && attempt < retries) {
        const wait = attempt * 3000;
        console.warn(`[broker] ${status} on attempt ${attempt} — retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      throw err;
    }
  }

  throw new Error("[broker] max retries exceeded");
}
