/**
 * laguna.ts
 *
 * Direct HTTP client for the Laguna affiliate MCP server.
 *
 * MCP Streamable HTTP requires:
 *   1. POST /mcp with "initialize" → server returns Mcp-Session-Id header
 *   2. All subsequent calls include that session header
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

// DEV environment — limited merchants, categories not fully tagged.
// Switch LAGUNA_MCP_URL to the production endpoint when Laguna goes live.
// Full merchant catalogue + category filters will work correctly in prod.
const MCP_URL =
  process.env.LAGUNA_MCP_URL ?? "https://agents-dev.laguna.network/mcp";

let _requestId = 1;
let _sessionId: string | null = null;
let _initPromise: Promise<void> | null = null;

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
// MCP session initializer
// ---------------------------------------------------------------------------

async function initSession(): Promise<void> {
  const body = {
    jsonrpc: "2.0",
    id: _requestId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nexus-gateway", version: "1.0.0" },
    },
  };

  console.log("[laguna] initializing MCP session at", MCP_URL);

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
    throw new Error(`[laguna] init HTTP ${res.status}: ${errText}`);
  }

  // Capture session ID if server returns one
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) {
    _sessionId = sessionId;
    console.log("[laguna] session established:", sessionId);
  } else {
    console.log("[laguna] no session ID returned — server may not require one");
  }

  // Send initialized notification
  await fetch(MCP_URL, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  }).catch(() => {
    /* notification is fire-and-forget */
  });
}

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (_sessionId) h["mcp-session-id"] = _sessionId;
  return h;
}

async function ensureSession(): Promise<void> {
  if (_sessionId !== null) return;
  if (!_initPromise) _initPromise = initSession();
  await _initPromise;
}

// ---------------------------------------------------------------------------
// Core JSON-RPC caller
// ---------------------------------------------------------------------------

async function callTool<T>(
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  await ensureSession();

  const id = _requestId++;
  const body = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  console.log(`[laguna] → ${toolName}`, JSON.stringify(args));

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`[laguna] ${toolName} HTTP ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const rawText = contentType.includes("text/event-stream")
    ? await readSSE(res)
    : await res.text();

  console.log(`[laguna] ← ${toolName} raw:`, rawText.slice(0, 300));

  // Parse JSON-RPC envelope
  let envelope: {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { message: string };
  };

  try {
    envelope = JSON.parse(rawText);
  } catch {
    try {
      return JSON.parse(rawText) as T;
    } catch {
      throw new Error(
        `[laguna] ${toolName} unparseable response: ${rawText.slice(0, 300)}`
      );
    }
  }

  if (envelope.error) {
    throw new Error(`[laguna] ${toolName} RPC error: ${envelope.error.message}`);
  }

  const content = envelope.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`[laguna] ${toolName} returned empty content`);
  }

  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  console.log(`[laguna] ← ${toolName} parsed:`, text.slice(0, 300));

  try {
    return JSON.parse(text) as T;
  } catch {
    return { raw: text } as unknown as T;
  }
}

// ---------------------------------------------------------------------------
// SSE reader
// ---------------------------------------------------------------------------

async function readSSE(res: Response): Promise<string> {
  const text = await res.text();
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]");

  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      JSON.parse(dataLines[i]);
      return dataLines[i];
    } catch {
      continue;
    }
  }
  return dataLines.join("\n");
}

// ---------------------------------------------------------------------------
// Public tool functions
// ---------------------------------------------------------------------------

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
  if (raw && typeof raw === "object" && "merchants" in raw && Array.isArray((raw as { merchants: Merchant[] }).merchants)) {
    return (raw as { merchants: Merchant[] }).merchants;
  }
  return [];
}

export async function getMerchantInfo(params: {
  merchant_id: string;
  geo?: string;
}): Promise<MerchantInfo> {
  return callTool<MerchantInfo>("get_merchant_info", params as Record<string, unknown>);
}

export async function mintLink(params: {
  merchant_id: string;
  wallet_address?: string;
  email?: string;
  geo?: string;
  target_url?: string;
}): Promise<MintedLink> {
  const args: Record<string, unknown> = { ...params };
  if (!args.wallet_address && process.env.LAGUNA_WALLET_ADDRESS) {
    args.wallet_address = process.env.LAGUNA_WALLET_ADDRESS;
  }
  if (!args.email && process.env.LAGUNA_EMAIL) {
    args.email = process.env.LAGUNA_EMAIL;
  }
  console.log(`[laguna] minting link for ${params.merchant_id} → wallet ${args.wallet_address}`);
  return callTool<MintedLink>("mint_link", args);
}

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
