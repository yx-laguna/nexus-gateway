/**
 * laguna.ts — Laguna Affiliate Network client
 *
 * Sovereign Reward Routing:
 *   When minting an affiliate link, the user's vault_address is passed
 *   as the wallet_address. This means Laguna creates (or reuses) an
 *   agent identity per unique wallet. USDC commission from purchases
 *   flows directly to the user's vault — not to the bot operator.
 *
 *   If the user hasn't set a vault, the fallback agent email is used
 *   so commissions still accrue (to the operator) rather than being lost.
 *
 * API Integration Note:
 *   This client targets the Laguna Agents REST API. The base URL and
 *   endpoints may need adjustment based on the actual Laguna docs.
 *   Current shape is inferred from the Laguna MCP tool interface.
 */

import axios from 'axios';

// ─── Config ─────────────────────────────────────────────────────────────

const LAGUNA_BASE = process.env.LAGUNA_API_BASE || 'https://agents-dev.laguna.network';
const LAGUNA_KEY = process.env.LAGUNA_API_KEY || '';
const FALLBACK_EMAIL = process.env.AGENT_FALLBACK_EMAIL || 'yixin@menyala.com';

const api = axios.create({
  baseURL: LAGUNA_BASE,
  timeout: 15_000,
  headers: {
    Authorization: `Bearer ${LAGUNA_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ─── Types ──────────────────────────────────────────────────────────────

export interface Merchant {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  bestRate: number;
  availableCountries: string[];
}

export interface CategoryRate {
  category: string;
  rate: number;
}

export interface MerchantDetail {
  id: string;
  name: string;
  description: string | null;
  bestRate: number;
  categoryRates: CategoryRate[];
  cookieDays: number;
  payoutDays: number;
  availableCountries: string[];
}

export interface MintedLink {
  shortcode: string;
  shortlink: string;
  merchantId: string;
  bestRate: number;
  categoryRates: CategoryRate[];
}

// ─── Merchant Catalog ───────────────────────────────────────────────────

/**
 * Curated merchant catalog grouped by category.
 * Sourced from Laguna's actual merchant list.
 * Update periodically or replace with a live API call.
 */
export const MERCHANT_CATALOG: Record<string, Merchant[]> = {
  'Travel': [
    { id: 'trip-com', name: 'Trip.com', description: null, category: 'Travel', bestRate: 9, availableCountries: ['SGP', 'HKG', 'USA', 'THA', 'VNM'] },
    { id: 'klook-pnr', name: 'Klook', description: null, category: 'Travel', bestRate: 9, availableCountries: ['SGP', 'HKG', 'USA', 'AUS', 'MYS'] },
    { id: 'kkday', name: 'KKday', description: null, category: 'Travel', bestRate: 9, availableCountries: ['SGP', 'HKG', 'AUS', 'MYS', 'USA'] },
    { id: 'agoda', name: 'Agoda', description: null, category: 'Travel', bestRate: 6.3, availableCountries: ['SGP', 'HKG', 'CHN', 'VNM'] },
    { id: 'ihg-amea', name: 'IHG Hotels', description: null, category: 'Travel', bestRate: 4.5, availableCountries: ['SGP', 'HKG', 'USA', 'CHN'] },
    { id: 'hyatt-hotel', name: 'Hyatt Hotels', description: null, category: 'Travel', bestRate: 4.5, availableCountries: ['SGP', 'USA', 'CHN', 'TWN'] },
    { id: 'hotels-com-reservation', name: 'Hotels.com', description: null, category: 'Travel', bestRate: 4.5, availableCountries: ['SGP', 'CHN', 'THA', 'TWN'] },
    { id: 'luxury-escapes', name: 'Luxury Escapes', description: null, category: 'Travel', bestRate: 3.6, availableCountries: ['SGP', 'AUS', 'HKG'] },
    { id: 'airasia-travel', name: 'AirAsia', description: null, category: 'Travel', bestRate: 1.8, availableCountries: ['SGP', 'MYS'] },
    { id: 'dusit-hotels-asai-hotels-reservation', name: 'Dusit Hotels', description: null, category: 'Travel', bestRate: 2.52, availableCountries: ['THA', 'VNM'] },
  ],
  'Fashion': [
    { id: 'shein-global', name: 'Shein', description: null, category: 'Fashion', bestRate: 12.6, availableCountries: ['SGP'] },
    { id: 'korena', name: 'KORENA', description: null, category: 'Fashion', bestRate: 15.75, availableCountries: ['SGP', 'HKG', 'VNM'] },
    { id: 'zalora', name: 'Zalora', description: null, category: 'Fashion', bestRate: 5.4, availableCountries: ['SGP'] },
    { id: 'nike', name: 'Nike', description: null, category: 'Fashion', bestRate: 5.4, availableCountries: ['SGP', 'MYS', 'PHL', 'TWN'] },
    { id: 'puma', name: 'Puma', description: null, category: 'Fashion', bestRate: 5.4, availableCountries: ['SGP', 'IDN', 'MYS', 'THA'] },
    { id: 'crocs', name: 'Crocs', description: null, category: 'Fashion', bestRate: 5.4, availableCountries: ['SGP'] },
    { id: 'cotton-on', name: 'Cotton On', description: null, category: 'Fashion', bestRate: 7.2, availableCountries: ['SGP', 'AUS', 'HKG', 'USA'] },
    { id: 'asos', name: 'ASOS', description: null, category: 'Fashion', bestRate: 1.8, availableCountries: ['SGP'] },
    { id: 'farfetch', name: 'FARFETCH', description: null, category: 'Fashion', bestRate: 9, availableCountries: ['SGP'] },
  ],
  'Shopping': [
    { id: 'shopee-id', name: 'Shopee', description: null, category: 'Shopping', bestRate: 26.1, availableCountries: ['SGP', 'CHN', 'HKG', 'VNM'] },
    { id: 'temu', name: 'Temu', description: null, category: 'Shopping', bestRate: 9, availableCountries: ['USA', 'ESP', 'FRA', 'ITA'] },
    { id: 'taobao', name: 'Taobao', description: null, category: 'Shopping', bestRate: 2.7, availableCountries: ['SGP', 'HKG', 'MYS', 'AUS'] },
    { id: 'dyson', name: 'Dyson', description: null, category: 'Shopping', bestRate: 3.15, availableCountries: [] },
    { id: 'iherb', name: 'iHerb', description: null, category: 'Shopping', bestRate: 0.9, availableCountries: ['SGP', 'AUS', 'HKG'] },
  ],
  'Tech & Gaming': [
    { id: 'nordvpn', name: 'NordVPN', description: null, category: 'Tech & Gaming', bestRate: 25.2, availableCountries: [] },
    { id: 'mysterium-vpn', name: 'Mysterium VPN', description: null, category: 'Tech & Gaming', bestRate: 18, availableCountries: ['VNM'] },
    { id: 'gamivo-update', name: 'GAMIVO', description: null, category: 'Tech & Gaming', bestRate: 9, availableCountries: ['SGP'] },
    { id: 'codashop', name: 'Codashop', description: null, category: 'Tech & Gaming', bestRate: 0.9, availableCountries: ['SGP', 'IDN', 'MYS', 'THA'] },
    { id: 'circles-life', name: 'Circles.Life', description: null, category: 'Tech & Gaming', bestRate: 4.5, availableCountries: ['SGP', 'AUS', 'HKG'] },
    { id: 'myrepublic-singapore-affiliate-program', name: 'MyRepublic', description: null, category: 'Tech & Gaming', bestRate: 2.7, availableCountries: ['SGP', 'HKG'] },
  ],
  'Luxury & Lifestyle': [
    { id: 'vertu', name: 'Vertu', description: null, category: 'Luxury & Lifestyle', bestRate: 9, availableCountries: ['SGP', 'HKG', 'USA'] },
    { id: 'the-loose-moose', name: 'The Loose Moose', description: null, category: 'Luxury & Lifestyle', bestRate: 8.1, availableCountries: ['SGP'] },
    { id: 'envolvetogether', name: 'Envolvetogether', description: null, category: 'Luxury & Lifestyle', bestRate: 6.3, availableCountries: ['SGP', 'USA', 'GBR'] },
    { id: 'yolofoods-health-wellness-community-program', name: 'YoloFoods', description: null, category: 'Luxury & Lifestyle', bestRate: 2.7, availableCountries: ['SGP', 'AUS', 'HKG'] },
  ],
};

export function getCategoryNames(): string[] {
  return Object.keys(MERCHANT_CATALOG);
}

export function getMerchantsByCategory(category: string): Merchant[] {
  return MERCHANT_CATALOG[category] || [];
}

export function findMerchantById(merchantId: string): Merchant | undefined {
  for (const merchants of Object.values(MERCHANT_CATALOG)) {
    const found = merchants.find((m) => m.id === merchantId);
    if (found) return found;
  }
  return undefined;
}

// ─── Laguna API Calls ───────────────────────────────────────────────────

/**
 * Mint an affiliate link with sovereign reward routing.
 *
 * If the user has a vault address, it's used as the wallet_address
 * so USDC commission flows directly to them. Otherwise, the
 * fallback agent email is used.
 */
export async function mintLink(
  merchantId: string,
  vaultAddress: string | null,
  geo?: string | null,
  targetUrl?: string
): Promise<MintedLink> {
  const params: Record<string, unknown> = { merchant_id: merchantId };

  // Sovereign routing: user vault takes priority
  if (vaultAddress) {
    params.wallet_address = vaultAddress;
  } else {
    params.email = FALLBACK_EMAIL;
  }

  if (geo) params.geo = geo;
  if (targetUrl) params.target_url = targetUrl;

  const res = await api.post('/v1/links/mint', params);
  const d = res.data;

  return {
    shortcode: d.shortcode,
    shortlink: d.shortlink,
    merchantId: d.merchant_id,
    bestRate: d.cashback?.rate ?? 0,
    categoryRates: d.cashback?.category_rates ?? [],
  };
}

/**
 * Get detailed merchant info from Laguna.
 */
export async function getMerchantInfo(
  merchantId: string,
  geo?: string | null
): Promise<MerchantDetail | null> {
  try {
    const params: Record<string, string> = {};
    if (geo) params.geo = geo;

    const res = await api.get(`/v1/merchants/${merchantId}`, { params });
    const d = res.data;

    return {
      id: d.merchant?.id ?? merchantId,
      name: d.merchant?.name ?? merchantId,
      description: d.merchant?.description ?? null,
      bestRate: d.cashback?.best_rate ?? 0,
      categoryRates: d.cashback?.category_rates ?? [],
      cookieDays: d.cashback?.cookie_days ?? 0,
      payoutDays: d.cashback?.payout_days ?? 0,
      availableCountries: d.cashback?.available_countries ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Search merchants via Laguna API (live search).
 * Falls back to local catalog if API is unavailable.
 */
export async function searchMerchants(
  query?: string,
  geo?: string | null,
  limit = 10
): Promise<Merchant[]> {
  try {
    const params: Record<string, unknown> = { limit };
    if (query) params.query = query;
    if (geo) params.geo = geo;
    params.sort = query ? 'relevance' : 'cashback_rate';

    const res = await api.get('/v1/merchants/search', { params });
    return (res.data.merchants ?? []).map((m: any) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      category: m.category,
      bestRate: m.bestRate ?? 0,
      availableCountries: m.availableCountries ?? [],
    }));
  } catch {
    // Fallback: search local catalog
    if (!query) {
      return Object.values(MERCHANT_CATALOG).flat().sort((a, b) => b.bestRate - a.bestRate).slice(0, limit);
    }
    const q = query.toLowerCase();
    return Object.values(MERCHANT_CATALOG)
      .flat()
      .filter((m) => m.name.toLowerCase().includes(q) || m.id.includes(q))
      .slice(0, limit);
  }
}
