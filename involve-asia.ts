/**
 * involve-asia.ts
 *
 * Direct client for Involve Asia's Deep Link Generator API — wraps our own Agoda
 * booking links (agoda-search.ts's landingURL) with real, wallet-attributable
 * affiliate tracking, while preserving the exact hotel + dates in the destination.
 *
 * Why this exists instead of routing through Laguna's own ACP mint_link: Laguna's
 * backend already has an Agoda relationship THROUGH Involve Asia — confirmed by
 * tracing a live mint_link redirect, which resolves through invl.me -> Agoda with
 * cid=1942726, the exact same cid this module's offer resolves to. But Laguna's
 * mint_link handler silently drops the target_url param for Agoda: three separate
 * live tests (our own dated hotel URL, no target_url at all, and a different hotel
 * URL) all produced the identical generic country-homepage redirect, never the
 * specific property.
 *
 * Calling Involve Asia's /deeplink/generate endpoint directly — same underlying
 * account, same Agoda offer, just bypassing Laguna's broken target_url handling —
 * DOES preserve the exact hotel/dates end to end. Verified live: wrapping our own
 * landingURL (unmodified) and tracing the resulting invl.me redirect lands on
 * agoda.com/search?...&selectedproperty=<our hotel_id>&checkin=...&checkout=...
 *
 * Docs: https://api.involve.asia/docs/#ep-deeplink
 * Requires INVOLVE_ASIA_API_KEY / INVOLVE_ASIA_API_SECRET (see .env.example).
 */

import "dotenv/config";
import { DatabaseSync } from "node:sqlite";

const AUTH_URL = "https://api.involve.asia/api/authenticate";
const DEEPLINK_URL = "https://api.involve.asia/api/deeplink/generate";

// "Agoda - CPS" — found via POST /api/offers/all and confirmed live (its redirect
// chain resolves to cid=1942726, the same cid Laguna's own backend already uses for
// Agoda). Hardcoded since offer IDs don't change day to day; re-fetching the whole
// offers list on every request just to find this one ID would be wasteful and burns
// nothing but is still an unnecessary round trip.
const AGODA_OFFER_ID = 4883;

// ---------------------------------------------------------------------------
// Auth — POST {key, secret} -> JWT. Observed ~2h expiry (iat/exp 7200s apart);
// refresh a little early rather than parsing the JWT payload ourselves.
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }

  const key = process.env.INVOLVE_ASIA_API_KEY;
  const secret = process.env.INVOLVE_ASIA_API_SECRET;
  if (!key || !secret) {
    throw new Error("[involve-asia] missing INVOLVE_ASIA_API_KEY / INVOLVE_ASIA_API_SECRET");
  }

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, secret }),
  });
  const text = await res.text();

  let parsed: { status?: string; message?: string; data?: { token?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`[involve-asia] unparseable auth response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (parsed.status !== "success" || !parsed.data?.token) {
    throw new Error(`[involve-asia] auth failed (HTTP ${res.status}): ${parsed.message ?? text.slice(0, 300)}`);
  }

  cachedToken = { token: parsed.data.token, expiresAt: Date.now() + 110 * 60 * 1000 };
  return cachedToken.token;
}

// ---------------------------------------------------------------------------
// Persistent cache — Involve Asia caps this endpoint at 1,000 unique links per
// rolling 30-day window per account. Deep links are only ever minted at confirmed
// purchase intent (never per search, never per candidate shown — same discipline
// as the raw Agoda landingURL already follows), but the same wallet can plausibly
// ask for the same hotel/dates link more than once in a conversation. Cache on
// disk (not just in-memory) so a Render restart/redeploy doesn't reset the count
// and burn quota re-minting links we already have.
// ---------------------------------------------------------------------------

const CACHE_DB_PATH = process.env.INVOLVE_ASIA_CACHE_DB_PATH ?? "./involve_asia_cache.sqlite";

let _cacheDb: DatabaseSync | null = null;

function getCacheDb(): DatabaseSync {
  if (_cacheDb) return _cacheDb;
  _cacheDb = new DatabaseSync(CACHE_DB_PATH);
  _cacheDb.exec(`
    CREATE TABLE IF NOT EXISTS deeplinks (
      cache_key TEXT PRIMARY KEY,
      tracking_link TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return _cacheDb;
}

function cacheKeyFor(walletAddress: string, hotelId: number, checkinDate: string, checkoutDate: string): string {
  return `${walletAddress.toLowerCase()}|${hotelId}|${checkinDate}|${checkoutDate}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeepLinkParams {
  walletAddress: string;
  hotelId: number;
  hotelName?: string;
  checkinDate: string;
  checkoutDate: string;
}

/**
 * Wraps an Agoda booking URL (our own landingURL, passed through unmodified — no
 * reformatting needed, verified live) with Involve Asia's deeplink generator so the
 * resulting link is attributable to the traveller's wallet via aff_sub, while still
 * landing on the exact hotel + dates. Falls back to the raw targetUrl (untracked but
 * still a working booking link) on any failure — cache miss, auth failure, quota
 * exhaustion, network error, whatever — since a working link always beats no link.
 */
export async function mintAgodaDeepLink(targetUrl: string, params: DeepLinkParams): Promise<string> {
  const key = cacheKeyFor(params.walletAddress, params.hotelId, params.checkinDate, params.checkoutDate);

  try {
    const row = getCacheDb()
      .prepare(`SELECT tracking_link FROM deeplinks WHERE cache_key = ?`)
      .get(key) as { tracking_link: string } | undefined;
    if (row) {
      console.log(`[involve-asia] cache hit for ${params.hotelName ?? params.hotelId}`);
      return row.tracking_link;
    }
  } catch (err) {
    console.warn(`[involve-asia] cache read failed, proceeding without it:`, err instanceof Error ? err.message : err);
  }

  let trackingLink: string;
  try {
    trackingLink = await generateDeepLink(targetUrl, params);
  } catch (err) {
    console.error(
      `[involve-asia] deeplink generation failed, falling back to raw Agoda link:`,
      err instanceof Error ? err.message : err
    );
    return targetUrl;
  }

  try {
    getCacheDb()
      .prepare(`INSERT OR REPLACE INTO deeplinks (cache_key, tracking_link, created_at) VALUES (?, ?, ?)`)
      .run(key, trackingLink, Date.now());
  } catch (err) {
    console.warn(`[involve-asia] cache write failed:`, err instanceof Error ? err.message : err);
  }

  return trackingLink;
}

async function generateDeepLink(targetUrl: string, params: DeepLinkParams, retried = false): Promise<string> {
  const token = await getToken();

  const body = new URLSearchParams({
    offer_id: String(AGODA_OFFER_ID),
    url: targetUrl,
    // aff_sub carries the wallet address so Involve Asia's conversion reports can be
    // reconciled back to a wallet later — this IS the wallet-level tracking mechanism,
    // no separate mapping table needed on our side beyond the quota cache above.
    aff_sub: params.walletAddress,
    aff_sub2: String(params.hotelId),
    aff_sub3: params.checkinDate,
    aff_sub4: params.checkoutDate,
  });

  const res = await fetch(DEEPLINK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await res.text();

  let parsed: { status?: string; message?: string; data?: { tracking_link?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`[involve-asia] unparseable deeplink response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  // Token expired/invalid mid-flight — refresh once and retry.
  if (!retried && (res.status === 401 || /unauthor/i.test(parsed.message ?? ""))) {
    await getToken(true);
    return generateDeepLink(targetUrl, params, true);
  }

  if (parsed.status !== "success" || !parsed.data?.tracking_link) {
    throw new Error(`[involve-asia] deeplink generate failed (HTTP ${res.status}): ${parsed.message ?? text.slice(0, 300)}`);
  }

  console.log(`[involve-asia] minted deep link for hotel ${params.hotelId} (wallet ${params.walletAddress.slice(0, 6)}...)`);
  return parsed.data.tracking_link;
}
