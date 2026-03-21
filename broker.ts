/**
 * broker.ts
 *
 * Calls DeepSeek V3 via the 0G Compute API key (app-sk-...).
 * OpenAI-compatible endpoint — no SDK, no broker, no thinking mode.
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

  if (!apiKey) throw new Error("ZG_API_KEY is not set. Exiting.");
  if (!endpoint) throw new Error("ZG_ENDPOINT is not set. Exiting.");

  _client = new OpenAI({ baseURL: endpoint, apiKey });
  console.log("[broker] DeepSeek client ready →", endpoint);
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

  return completion.choices[0]?.message?.content?.trim() ?? "";
}
