/**
 * broker.ts
 *
 * Wraps the 0G Compute Network broker (createZGComputeNetworkBroker) to provide
 * OpenAI-compatible chat completions using DeepSeek V3.
 */

import "dotenv/config";
import { createRequire } from "module";
import { ethers } from "ethers";
import OpenAI from "openai";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { createZGComputeNetworkBroker } = require("@0glabs/0g-serving-broker") as any;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// ---------------------------------------------------------------------------
// Broker singleton
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _broker: any = null;

async function getBroker() {
  if (_broker) return _broker;

  const rpcUrl = process.env.ZG_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;

  if (!rpcUrl) throw new Error("ZG_RPC_URL is not set");
  if (!privateKey) throw new Error("PRIVATE_KEY is not set");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  _broker = await createZGComputeNetworkBroker(wallet);
  console.log("[broker] 0G compute broker initialized");

  // Log available providers so you can pick a valid ZG_PROVIDER_ADDRESS
  try {
    const services = await _broker.inference.listService();
    console.log("[broker] Available providers on 0G network:");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services.forEach((s: any) => {
      console.log(`  provider=${s.provider}  model=${s.name ?? s.model ?? "?"}  url=${s.url ?? s.endpoint ?? "?"}`);
    });
  } catch (e) {
    console.warn("[broker] Could not list services:", e);
  }

  return _broker;
}

// ---------------------------------------------------------------------------
// Public inference function
// ---------------------------------------------------------------------------

export async function chat(
  messages: ChatMessage[],
  jsonMode = false
): Promise<string> {
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS;
  if (!providerAddress) throw new Error("ZG_PROVIDER_ADDRESS is not set");

  const broker = await getBroker();

  // 1. Get provider endpoint + model name
  const { endpoint, model } = await broker.inference.getServiceMetadata(
    providerAddress
  );

  // 2. Get signed request headers
  const headers = await broker.inference.getRequestHeaders(providerAddress);

  // 3. Call the OpenAI-compatible endpoint
  const openai = new OpenAI({
    baseURL: endpoint,
    apiKey: "not-needed",
    defaultHeaders: headers,
  });

  const completion = await openai.chat.completions.create({
    model,
    messages,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  return completion.choices[0]?.message?.content ?? "";
}
