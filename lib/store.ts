/**
 * store.ts — Vercel KV session store
 *
 * Maps each Telegram user to:
 *   - vault_address  (EVM address for sovereign reward routing)
 *   - geo            (ISO-3166 country code for Laguna geo-targeting)
 *   - last_active    (ISO timestamp)
 *
 * Key schema:
 *   nexus:user:{telegram_id}        → ShopperSession
 *   nexus:conversation:{telegram_id} → last N messages for Mind context
 */

import { kv } from '@vercel/kv';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ShopperSession {
  telegram_id: string;
  vault_address: string | null;
  geo: string | null;
  username: string | null;
  last_active: string;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

const KEY_PREFIX = 'nexus:user:';
const CONVO_PREFIX = 'nexus:convo:';
const MAX_CONVO_HISTORY = 10; // keep last N exchanges per user
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

// ─── Session CRUD ───────────────────────────────────────────────────────

export async function getSession(telegramId: string): Promise<ShopperSession | null> {
  return kv.get<ShopperSession>(`${KEY_PREFIX}${telegramId}`);
}

export async function upsertSession(
  telegramId: string,
  patch: Partial<Omit<ShopperSession, 'telegram_id'>>
): Promise<ShopperSession> {
  const existing = await getSession(telegramId);
  const session: ShopperSession = {
    telegram_id: telegramId,
    vault_address: patch.vault_address ?? existing?.vault_address ?? null,
    geo: patch.geo ?? existing?.geo ?? null,
    username: patch.username ?? existing?.username ?? null,
    last_active: new Date().toISOString(),
  };
  await kv.set(`${KEY_PREFIX}${telegramId}`, session, { ex: SESSION_TTL_SECONDS });
  return session;
}

export async function setVaultAddress(telegramId: string, address: string): Promise<ShopperSession> {
  return upsertSession(telegramId, { vault_address: address });
}

export async function setGeo(telegramId: string, geo: string): Promise<ShopperSession> {
  return upsertSession(telegramId, { geo: geo.toUpperCase() });
}

// ─── Conversation History (for multi-tenant Mind context) ───────────────

export async function getConversation(telegramId: string): Promise<ConversationEntry[]> {
  const entries = await kv.get<ConversationEntry[]>(`${CONVO_PREFIX}${telegramId}`);
  return entries ?? [];
}

export async function appendConversation(
  telegramId: string,
  role: 'user' | 'assistant',
  text: string
): Promise<void> {
  const history = await getConversation(telegramId);
  history.push({ role, text, ts: new Date().toISOString() });

  // Trim to last N entries
  const trimmed = history.slice(-MAX_CONVO_HISTORY);
  await kv.set(`${CONVO_PREFIX}${telegramId}`, trimmed, { ex: SESSION_TTL_SECONDS });
}

export async function clearConversation(telegramId: string): Promise<void> {
  await kv.del(`${CONVO_PREFIX}${telegramId}`);
}
