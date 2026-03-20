/**
 * laguna.ts
 *
 * Thin client for the Laguna affiliate MCP server.
 *
 * The Laguna MCP server exposes affiliate tools over the Model Context Protocol
 * (Streamable HTTP transport).  We call each tool by POSTing a JSON-RPC 2.0
 * "tools/call" message and reading the streaming response back to completion.
 *
 * Tools exposed:
 *   • search_merchants   – fuzzy-search/browse merchants by query or category
 *   • get_merchant_info  – detailed rates and cookie info for a single merchant
 *   • mint_link          – create a tracked affiliate shortlink
 *   • get_dashboard      – wallet balance + conversion stats
 */

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Merchant {
  id: string;
  name: string;
  cashback_rate?: number | string;
  category?: string;
  description?: string;
  [key: string]: unknown;
}

export interface MerchantInfo extends Merchant {
  cookie_duration?: string;
  payout_timeline?: string;
  rates?: unknown[];
}

export interface MintedLink {
  shortlink: string;
  merchant_id: string;
  target_url?: string;
}

export interface Dashboard {
  balance?: number | string;
  conversions?: unknown[];
  analytics?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP client singleton
// ---------------------------------------------------------------------------

const MCP_URL = process.env.LAGUNA_MCP_URL ?? "https://agents-dev.laguna.network/mcp";

let _client: Client | null = null;

async function getClient(): Promise<Client> {
  if (_client) return _client;

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client(
    { name: "nexus-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  await client.connect(transport);
  console.log("[laguna] MCP client connected to", MCP_URL);

  _client = client;
  return client;
}

// ---------------------------------------------------------------------------
// Helper: call a tool and return parsed content
// ---------------------------------------------------------------------------

async function callTool<T>(
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args });

  // MCP returns content as an array of { type, text } blocks
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`[laguna] empty response from tool "${name}"`);
  }

  const text = content
    .filter((c): c is { type: string; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  try {
    return JSON.parse(text) as T;
  } catch {
    // Some tools return plain text — wrap it so callers always get an object
    return { raw: text } as unknown as T;
  }
}

// ---------------------------------------------------------------------------
// Public tool functions
// ---------------------------------------------------------------------------

/** Search or browse affiliate merchants. */
export async function searchMerchants(params: {
  query?: string;
  category?: string;
  geo?: string;
  limit?: number;
  sort?: "relevance" | "cashback_rate" | "name";
}): Promise<Merchant[]> {
  const raw = await callTool<{ merchants?: Merchant[] } | Merchant[]>(
    "search_merchants",
    params
  );
  // Normalise: server may return { merchants: [...] } or a bare array
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && "merchants" in raw && Array.isArray(raw.merchants)) {
    return raw.merchants;
  }
  return [];
}

/** Get detailed info (rates, cookie duration) for a specific merchant. */
export async function getMerchantInfo(params: {
  merchant_id: string;
  geo?: string;
}): Promise<MerchantInfo> {
  return callTool<MerchantInfo>("get_merchant_info", params);
}

/** Create a tracked affiliate shortlink for a merchant. */
export async function mintLink(params: {
  merchant_id: string;
  wallet_address?: string;
  email?: string;
  geo?: string;
  target_url?: string;
}): Promise<MintedLink> {
  const args: Record<string, unknown> = { ...params };

  // Inject operator wallet/email from env if not overridden per-call
  if (!args.wallet_address && process.env.LAGUNA_WALLET_ADDRESS) {
    args.wallet_address = process.env.LAGUNA_WALLET_ADDRESS;
  }
  if (!args.email && process.env.LAGUNA_EMAIL) {
    args.email = process.env.LAGUNA_EMAIL;
  }

  return callTool<MintedLink>("mint_link", args);
}

/** Fetch agent dashboard: balance + conversion history. */
export async function getDashboard(params?: {
  wallet_address?: string;
  email?: string;
  include?: string[];
}): Promise<Dashboard> {
  const args: Record<string, unknown> = { ...(params ?? {}) };

  if (!args.wallet_address && process.env.LAGUNA_WALLET_ADDRESS) {
    args.wallet_address = process.env.LAGUNA_WALLET_ADDRESS;
  }
  if (!args.email && process.env.LAGUNA_EMAIL) {
    args.email = process.env.LAGUNA_EMAIL;
  }

  return callTool<Dashboard>("get_dashboard", args);
}
