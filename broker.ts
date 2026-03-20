/**
 * broker.ts
 *
 * Wraps the 0G Serving Network broker to provide OpenAI-compatible chat
 * completions using DeepSeek V3 hosted on the 0G Compute network.
 *
 * Flow:
 *   1. Init ethers wallet from PRIVATE_KEY
 *   2. Create ZG serving broker (manages on-chain billing accounts)
 *   3. For each request: fetch service metadata → build signed request headers
 *      → call the provider's OpenAI-compatible endpoint → settle fee
 */

import "dotenv/config";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import ZGModule from "@0glabs/0g-serving-broker";
// The package may export the factory as default or as a named member
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createZGServingNetworkBroker: (signer: any) => Promise<any> =
  (ZGModule as any).createZGServingNetworkBroker ?? ZGModule;
import { ethers } from "ethers";
import OpenAI from "openai";

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

  if (!rpcUrl) throw new Error("ZG_RPC_URL is not set in environment");
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in environment");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  _broker = await createZGServingNetworkBroker(wallet);
  console.log("[broker] 0G serving broker initialized");
  return _broker;
}

// ---------------------------------------------------------------------------
// Public inference function
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request to DeepSeek V3 via the 0G Compute network.
 *
 * @param messages   Full conversation history (system + user + assistant turns)
 * @param jsonMode   When true, instructs the model to respond with valid JSON
 */
export async function chat(
  messages: ChatMessage[],
  jsonMode = false
): Promise<string> {
  const providerAddress = process.env.ZG_PROVIDER_ADDRESS;
  const serviceName = process.env.ZG_SERVICE_NAME ?? "deepseek-v3";

  if (!providerAddress) {
    throw new Error("ZG_PROVIDER_ADDRESS is not set in environment");
  }

  const broker = await getBroker();

  // 1. Fetch the provider's endpoint + canonical model name
  const { endpoint, model } = await broker.getServiceMetadata(
    providerAddress,
    serviceName
  );

  // 2. Build signed request headers (0G handles ZK-proof billing under the hood)
  //    The last user message content is used to compute billing metadata.
  const lastUserContent =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const { headers } = await broker.getRequestHeaders(
    providerAddress,
    serviceName,
    lastUserContent
  );

  // 3. Call the OpenAI-compatible endpoint
  const openai = new OpenAI({
    baseURL: endpoint,
    apiKey: "not-needed", // auth is handled via broker headers
    defaultHeaders: headers,
  });

  const completion = await openai.chat.completions.create({
    model,
    messages,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  const text = completion.choices[0]?.message?.content ?? "";

  // 4. Settle the fee on-chain (non-blocking — fire and forget)
  broker
    .settleFee(providerAddress, serviceName, 0.001)
    .catch((err: unknown) =>
      console.warn("[broker] fee settlement warning:", err)
    );

  return text;
}
