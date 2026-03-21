/**
 * broker.ts
 *
 * Calls DeepSeek V3 via the 0G Compute API key (app-sk-...).
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

  const apiKey = process.env.ZG_API_KEY;
  const endpoint = process.env.ZG_ENDPOINT;

  if (!apiKey) throw new Error("ZG_API_KEY is not set.");
  if (!endpoint) throw new Error("ZG_ENDPOINT is not set.");

  _client = new OpenAI({ baseURL: endpoint, apiKey });
  console.log("[broker] DeepSeek client ready →", endpoint);
  return _client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(
  messages: ChatMessage[],
  jsonMode = false,
  retries = 3
): Promise<string> {
  const model = process.env.ZG_SERVICE_NAME ?? "deepseek-chat-v3-0324";
  const client = getClient();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model,
        messages,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      });
      return completion.choices[0]?.message?.content?.trim() ?? "";
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const isRateLimit = status === 429;
      const isServerError = status !== undefined && status >= 500;

      if ((isRateLimit || isServerError) && attempt < retries) {
        const wait = attempt * 3000; // 3s, 6s, 9s
        console.warn(`[broker] ${status} on attempt ${attempt} — retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      throw err;
    }
  }

  throw new Error("[broker] max retries exceeded");
}
