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

/**
 * Strip reasoning/thinking content from Qwen3 and similar models.
 * Handles: <think>...</think>, unclosed <think>, and raw "Thinking Process:" dumps.
 */
function stripThinking(raw: string): string {
  let out = raw;

  // Remove complete <think>...</think> blocks (greedy — handles nested content)
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Remove unclosed <think> blocks — everything from <think> to end of string
  out = out.replace(/<think>[\s\S]*/gi, "");

  // Remove lines that look like raw reasoning dumps
  const reasoningPatterns = [
    /^(Thinking Process|Chain of Thought|Let me think|Step \d+[:.])[\s\S]*/im,
    /^\d+\.\s+(Analyze|Consider|Think|Review|Plan|Draft|Refine|Check|Final Polish)[\s\S]*/im,
  ];
  for (const pattern of reasoningPatterns) {
    const match = out.search(pattern);
    if (match !== -1) {
      // Only cut if the actual reply content starts before this reasoning block
      const before = out.slice(0, match).trim();
      if (before.length > 0) {
        out = before;
      } else {
        // Reasoning is at the top — find where the real reply starts
        // (look for emoji or a short line after the reasoning block)
        const lines = out.split("\n");
        const firstContentLine = lines.findIndex(
          (l) => l.trim().length > 0 && !/^\d+\./.test(l.trim())
        );
        if (firstContentLine > 0) {
          out = lines.slice(firstContentLine).join("\n");
        }
      }
    }
  }

  return out.trim();
}

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
    // Disable Qwen3 thinking mode — direct answers only, no reasoning trace
    ...({
      extra_body: {
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      },
    } as object),
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  return stripThinking(raw);
}
