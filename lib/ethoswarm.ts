/**
 * ethoswarm.ts — Reasoning-as-a-Service (RaaS) client
 *
 * Calls the Travelshopper HQ Mind on Ethoswarm for shopping intelligence.
 * Solves the multi-tenant problem by:
 *   1. Injecting a per-user shopper_id into the system context
 *   2. Prepending conversation history so the Mind can distinguish users
 *   3. Including the user's vault_address and geo for sovereign routing
 *
 * The Mind sees: "Shopper TG-12345 (vault: 0x…, geo: SG) is asking: …"
 * This way the Mind treats each Telegram user as a separate session,
 * even though all requests come through a single API key.
 */

import axios, { AxiosError } from 'axios';
import type { ShopperSession, ConversationEntry } from './store';

// ─── Config ─────────────────────────────────────────────────────────────

const ETHOSWARM_API_BASE = 'https://api.ethoswarm.ai/v1';
const MIND_ID = process.env.ETHOSWARM_MIND_ID || '4E199F32-0D21-F111-AD1D-0EA9A5017E89';
const API_KEY = process.env.ETHOSWARM_API_KEY || '';

// ─── Types ──────────────────────────────────────────────────────────────

export interface MindResponse {
  reply: string;        // The Mind's text response
  replyHTML?: string;   // HTML-formatted variant (if the Mind supports it)
  intent?: string;      // Detected shopping intent (e.g. "purchase", "compare", "browse")
  merchants?: string[]; // Merchant IDs mentioned in the response
  raw?: unknown;        // Full API response for debugging
}

// ─── Multi-Tenant Context Builder ───────────────────────────────────────

function buildContextPayload(
  userMessage: string,
  session: ShopperSession,
  history: ConversationEntry[]
) {
  // Build a conversation preamble so the Mind has per-user context
  const historyBlock = history
    .map((e) => `[${e.role === 'user' ? 'Shopper' : 'Nexus'}]: ${e.text}`)
    .join('\n');

  const contextPreamble = [
    `--- Nexus Gateway Context ---`,
    `Shopper ID: TG-${session.telegram_id}`,
    `Vault: ${session.vault_address || 'Not set'}`,
    `Geo: ${session.geo || 'Unknown'}`,
    `Platform: Nexus-Telegram-Gateway`,
    history.length > 0 ? `\n--- Recent Conversation ---\n${historyBlock}` : '',
    `--- Current Message ---`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    mindId: MIND_ID,
    text: `${contextPreamble}\n${userMessage}`,
    context: {
      shopper_id: `TG-${session.telegram_id}`,
      vault_address: session.vault_address,
      geo: session.geo,
      platform: 'Nexus-Gateway',
      username: session.username,
    },
  };
}

// ─── API Call ────────────────────────────────────────────────────────────

export async function queryMind(
  userMessage: string,
  session: ShopperSession,
  history: ConversationEntry[]
): Promise<MindResponse> {
  const payload = buildContextPayload(userMessage, session, history);

  try {
    const res = await axios.post(
      `${ETHOSWARM_API_BASE}/minds/${MIND_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );

    const data = res.data;

    // Adapt to whatever shape the Ethoswarm API returns.
    // Adjust these field names once you've confirmed the actual response schema.
    return {
      reply: data.reply || data.text || data.message || JSON.stringify(data),
      replyHTML: data.replyHTML || data.reply_html || undefined,
      intent: data.intent || undefined,
      merchants: data.merchants || undefined,
      raw: data,
    };
  } catch (err) {
    const axErr = err as AxiosError;
    console.error(
      '[Ethoswarm] Mind query failed:',
      axErr.response?.status,
      axErr.response?.data || axErr.message
    );

    // Return a graceful fallback
    return {
      reply:
        'The Shopping Intelligence engine is recalibrating. Please try again in a moment.',
    };
  }
}
