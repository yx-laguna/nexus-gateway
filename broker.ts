/**
 * broker.ts
 *
 * Uses a pre-generated 0G Compute API key (app-sk-...) to call DeepSeek V3
 * via the provider's OpenAI-compatible endpoint.
 *
 * No on-chain broker SDK needed — the API key handles auth directly.
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

  if (!apiKey) throw new Error("ZG_API_KEY is not set");
  if (!endpoint) throw new Error("ZG_ENDPOINT is not set");

  _client = new OpenAI({ baseURL: endpoint, apiKey });
  console.log("[broker] 0G client ready →", endpoint);
  return _client;
}

export async function chat(
  messages: ChatMessage[],
  jsonMode = false
): Promise<string> {
  const model = process.env.ZG_SERVICE_NAME ?? "deepseek-chat-v3-0324";
  const client = getClient();

  const completion = await client.chat.completions.create({
    model,
    messages,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  // Qwen3.5 and other reasoning models emit <think>...</think> blocks.
  // Strip them so only the final answer reaches the user.
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
