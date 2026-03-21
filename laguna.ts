/**
 * laguna.ts
 *
 * Direct HTTP client for the Laguna affiliate MCP server.
 * Calls the MCP JSON-RPC endpoint at LAGUNA_MCP_URL via plain fetch —
 * no SDK transport layer, no silent failures.
 *
 * Tools:
 *   • search_merchants   – find merchants by query / category
 *   • get_merchant_info  – cashback rates + cookie info for one merchant
 *   • mint_link          – generate a tracked affiliate shortlink
 *   • get_dashboard      – wallet balance + conversion history
 */

import "dotenv/config";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MCP_URL =
  process.env.LAGUNA_MCP_URL ?? "https://agents-dev.laguna.network/mcp";

let _requestId = 1;

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
  [key: string]: unknown;
}

export interface Dashboard {
  balance?: number | string;
  conversions?: unknown[];
  analytics?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Core JSON-RPC caller
// ---------------------------------------------------------------------------

async function callTool<T>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  const id = _requestId++;
  const body = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  };

  console.log(`[laguna] → ${toolName}`, JSON.stringify(args));

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`[laguna] ${toolName} HTTP ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  let responseText: string;

  if (contentType.includes("text/event-stream")) {
    // SSE stream — collect all data: lines and concatenate
    responseText = await readSSE(res);
  } else {
    responseText = await res.text();
  }

  // Parse outer JSON-RPC envelope
  let envelope: {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { message: string };
  };

  try {
    envelope = JSON.parse(responseText);
  } catch {
    // Some responses are raw JSON (not wrapped in JSON-RPC envelope)
    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new Error(`[laguna] ${toolName} unparseable response: ${responseText.slice(0, 200)}`);
    }
  }

  if (envelope.error) {
    throw new Error(`[laguna] ${toolName} error: ${envelope.error.message}`);
  }

  // Extract text content from MCP result
  const content = envelope.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`[laguna] ${toolName} returned empty content`);
  }

  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  console.log(`[laguna] ← ${toolName}`, text.slice(0, 200));

  try {
    return JSON.parse(text) as T;
  } catch {
    return { raw: text } as unknown as T;
  }
}

// ---------------------------------------------------------------------------
// SSE reader — collects "data:" lines from a streaming response
// ---------------------------------------------------------------------------

async function readSSE(res: Response): Promise<string> {
  const text = await res.text();
  const lines = text.split("\n");
  const dataLines = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]");

  // Return last non-empty data line (the final JSON-RPC result)
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const line = dataLines[i];
    try {
      JSON.parse(line); // validate it's parseable
      return line;
    } catch {
      continue;
    }
  }

  return dataLines.join("\n");
}

// ---------------------------------------------------------------------------
// Public tool functions
// ---------------------------------------------------------------------------

/** Search or browse affiliate merchants by query and/or category. */
export async function searchMerchants(params: {
  query?: string;
  category?: string;
  geo?: string;
  limit?: number;
  sort?: "relevance" | "cashback_rate" | "name";
}): Promise<Merchant[]> {
  const raw = await callTool<Merchant[] | { merchants?: Merchant[] }>(
    "search_merchants",
    params as Record<string, unknown>
  );

  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && "merchants" in raw && Array.isArray(raw.merchants)) {
    return raw.merchants;
  }
  return [];
}

/** Get detailed rates and info for a specific merchant. */
export async function getMerchantInfo(params: {
  merchant_id: string;
  geo?: string;
}): Promise<MerchantInfo> {
  return callTool<MerchantInfo>(
    "get_merchant_info",
    params as Record<string, unknown>
  );
}

/**
 * Mint a tracked affiliate shortlink for a merchant.
 * wallet_address is the user's EVM address — commissions go there directly.
 */
export async function mintLink(params: {
  merchant_id: string;
  wallet_address?: string;
  email?: string;
  geo?: string;
  target_url?: string;
}): Promise<MintedLink> {
  const args: Record<string, unknown> = { ...params };

  // Fallback to operator env vars if user hasn't set a wallet
  if (!args.wallet_address && process.env.LAGUNA_WALLET_ADDRESS) {
    args.wallet_address = process.env.LAGUNA_WALLET_ADDRESS;
  }
  if (!args.email && process.env.LAGUNA_EMAIL) {
    args.email = process.env.LAGUNA_EMAIL;
  }

  console.log(`[laguna] minting link for ${params.merchant_id} → wallet ${args.wallet_address}`);
  return callTool<MintedLink>("mint_link", args);
}

/** Fetch dashboard: balance + conversion history for a wallet. */
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
