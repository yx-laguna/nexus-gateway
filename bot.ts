/**
 * bot.ts — Opi Telegram bot
 *
 * Onboarding flow (first-time users):
 *   /start → warm welcome → ask country → ask wallet → ready
 *
 * Returning users skip onboarding and go straight to shopping.
 *
 * Commands:
 *   /start       – welcome / show current profile
 *   /setwallet   – save EVM wallet address
 *   /setcountry  – update shopping country
 *   /mywallet    – show saved profile
 *   /new         – clear conversation history
 *   /dashboard   – Laguna earnings summary
 */

import "dotenv/config";
import { createServer } from "http";
import { readFileSync, writeFileSync } from "fs";
import { Bot, GrammyError, HttpError, type Context } from "grammy";
import { processMessage, clearHistory } from "./agent.js";
import { getDashboard } from "./laguna.js";

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN is not set. Exiting."); process.exit(1); }

// ---------------------------------------------------------------------------
// Per-user profile store
// ---------------------------------------------------------------------------

type OnboardingStep = "awaiting_country" | "awaiting_wallet" | "complete";

interface UserProfile {
  name?: string;
  wallet?: string;
  country?: string;          // ISO 3166-1 alpha-2 e.g. "SG"
  onboarding?: OnboardingStep;
}

const PROFILES_FILE = "./profiles.json";

function loadProfiles(): Map<number, UserProfile> {
  try {
    const raw = readFileSync(PROFILES_FILE, "utf8");
    return new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [Number(k), v as UserProfile]));
  } catch { return new Map(); }
}

function saveProfiles(map: Map<number, UserProfile>) {
  writeFileSync(PROFILES_FILE, JSON.stringify(Object.fromEntries(map)), "utf8");
}

const profiles = loadProfiles();
console.log(`[bot] Loaded ${profiles.size} saved profile(s)`);

function getProfile(userId: number): UserProfile { return profiles.get(userId) ?? {}; }

function updateProfile(userId: number, update: Partial<UserProfile>) {
  profiles.set(userId, { ...getProfile(userId), ...update });
  saveProfiles(profiles);
}

// ---------------------------------------------------------------------------
// Country parsing — explicit whitelist only, never auto-match 2 random letters
// ---------------------------------------------------------------------------

const COUNTRY_MAP: Record<string, string> = {
  // Full names
  "singapore": "SG", "malaysia": "MY", "indonesia": "ID", "thailand": "TH",
  "philippines": "PH", "vietnam": "VN", "australia": "AU", "japan": "JP",
  "south korea": "KR", "korea": "KR", "china": "CN", "india": "IN",
  "united kingdom": "GB", "england": "GB", "uk": "GB",
  "united states": "US", "united states of america": "US", "usa": "US", "america": "US",
  "uae": "AE", "united arab emirates": "AE", "dubai": "AE",
  "germany": "DE", "france": "FR", "canada": "CA", "hong kong": "HK",
  "taiwan": "TW", "new zealand": "NZ", "netherlands": "NL", "switzerland": "CH",
  "italy": "IT", "spain": "ES", "mexico": "MX", "brazil": "BR",
  "saudi arabia": "SA", "qatar": "QA", "turkey": "TR", "egypt": "EG",
  "nigeria": "NG", "kenya": "KE", "south africa": "ZA",
  // Common codes (explicit — NOT a generic 2-letter fallback)
  "sg": "SG", "my": "MY", "id": "ID", "th": "TH", "ph": "PH",
  "vn": "VN", "au": "AU", "jp": "JP", "kr": "KR", "cn": "CN",
  "in": "IN", "gb": "GB", "us": "US", "ae": "AE", "de": "DE",
  "fr": "FR", "ca": "CA", "hk": "HK", "tw": "TW", "nz": "NZ",
};

function parseCountry(input: string): string | null {
  const clean = input.trim().toLowerCase().replace(/[^a-z\s]/g, "");
  return COUNTRY_MAP[clean] ?? null;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Bot(token);

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

bot.command("start", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const profile = getProfile(userId);
  const firstName = ctx.from?.first_name ?? "there";

  // Returning user with full profile — skip onboarding
  if (profile.onboarding === "complete" && profile.country && profile.wallet) {
    await ctx.reply(
      `👋 Welcome back! Here's your profile:\n\n` +
      `🌍 Country: *${profile.country}*\n` +
      `💳 Wallet: \`${profile.wallet}\`\n\n` +
      `Just tell me what you're looking for and I'll find the best deals!`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // New user — start onboarding
  updateProfile(userId, { onboarding: "awaiting_country" });
  await ctx.reply(
    `👋 Hey ${firstName}! I'm *Opi* — your personal travel & shopping assistant.\n\n` +
    `I find the best deals on flights, hotels, and shopping — and pass the cashback *directly to your crypto wallet*.\n\n` +
    `Let's get you set up! First — *where are you shopping and booking from?*\n\n` +
    `Just reply with your country, e.g:\n_Singapore_, _Hong Kong_, _United States_`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /setwallet  0x...
// ---------------------------------------------------------------------------

bot.command("setwallet", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const parts = ctx.message?.text?.trim().split(/\s+/);
  const address = parts?.[1];

  if (!address || !EVM_ADDRESS_RE.test(address)) {
    await ctx.reply(
      `⚠️ Please provide a valid EVM wallet address.\n\nExample:\n\`/setwallet 0xAbCd...1234\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const profile = getProfile(userId);
  const isOnboarding = profile.onboarding === "awaiting_wallet";

  updateProfile(userId, { wallet: address, onboarding: "complete" });
  const updated = getProfile(userId);

  await ctx.reply(
    `✅ *Wallet saved!*\n\`${address}\`\n\n` +
    (isOnboarding && updated.country
      ? `You're all set! 🎉 Just tell me what you're planning — I'll find the best deals and send cashback straight to your wallet.`
      : updated.country
        ? `Wallet updated. Tell me what you're looking for!`
        : `One more thing — what country are you shopping from?\nReply with e.g. _Singapore_ or use \`/setcountry Singapore\``),
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /setcountry
// ---------------------------------------------------------------------------

bot.command("setcountry", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const parts = ctx.message?.text?.trim().split(/\s+/);
  const input = parts?.slice(1).join(" ");

  if (!input) {
    await ctx.reply(`Please include your country. Example:\n\`/setcountry Singapore\``, { parse_mode: "Markdown" });
    return;
  }

  const code = parseCountry(input);
  if (!code) {
    await ctx.reply(
      `⚠️ I didn't recognise that country.\n\nTry the full name or a known code, e.g.:\n\`/setcountry Singapore\` or \`/setcountry SG\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const profile = getProfile(userId);
  updateProfile(userId, { country: code });

  await ctx.reply(
    `✅ *Country updated to ${code}!*\n\n` +
    (profile.wallet
      ? `You're good to go. What are you shopping for?`
      : `Now add your wallet to receive cashback:\n\`/setwallet 0xYourAddress\``),
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /mywallet — show full profile
// ---------------------------------------------------------------------------

bot.command("mywallet", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const profile = getProfile(userId);

  await ctx.reply(
    `*Your Opi Profile*\n\n` +
    `🌍 Country: ${profile.country ? `*${profile.country}*` : `not set — \`/setcountry Singapore\``}\n` +
    `💳 Wallet: ${profile.wallet ? `\`${profile.wallet}\`` : `not set — \`/setwallet 0xYourAddress\``}`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /new — reset conversation
// ---------------------------------------------------------------------------

bot.command("new", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (userId) clearHistory(userId);
  await ctx.reply("Fresh start! What are you planning? ✈️🛍️");
});

// ---------------------------------------------------------------------------
// /dashboard
// ---------------------------------------------------------------------------

bot.command("dashboard", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { wallet } = getProfile(userId);
  if (!wallet) {
    await ctx.reply(`Set your wallet first:\n\`/setwallet 0xYourAddress\``, { parse_mode: "Markdown" });
    return;
  }

  const msg = await ctx.reply("Fetching your dashboard…");
  try {
    const data = await getDashboard({ wallet_address: wallet, include: ["conversions", "analytics"] });
    const balance = data.balance !== undefined ? `$${data.balance} USDC` : "N/A";
    const conversions = Array.isArray(data.conversions) ? data.conversions.length : "N/A";

    await ctx.api.editMessageText(
      ctx.chat!.id, msg.message_id,
      `📊 *Your Opi Dashboard*\n\n` +
      `💰 Balance: *${balance}*\n` +
      `🔗 Conversions: *${conversions}*\n\n` +
      `Wallet: \`${wallet}\`\n` +
      `_Payouts settle in USDC on Base chain_`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `⚠️ Could not fetch dashboard: ${errMsg}`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TG_LENGTH = 4096;

async function sendChunk(ctx: Context, text: string) {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text.replace(/[*_`[\]]/g, ""));
  }
}

async function sendLongMessage(ctx: Context, text: string) {
  if (text.length <= MAX_TG_LENGTH) { await sendChunk(ctx, text); return; }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TG_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n\n", MAX_TG_LENGTH);
    if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", MAX_TG_LENGTH);
    if (splitAt === -1) splitAt = MAX_TG_LENGTH;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) await sendChunk(ctx, chunk);
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

bot.on("message:text", async (ctx: Context) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (!userId || !text || text.startsWith("/")) return;

  const profile = getProfile(userId);

  // ── Onboarding: awaiting country ────────────────────────────────────────
  if (profile.onboarding === "awaiting_country") {
    const code = parseCountry(text);
    if (!code) {
      await ctx.reply(
        `I didn't catch that country 😅\n\nTry typing the full name, e.g:\n_Singapore_, _Hong Kong_, _United States_`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    updateProfile(userId, { country: code, onboarding: "awaiting_wallet" });
    await ctx.reply(
      `🌍 Got it — *${code}*!\n\n` +
      `Now, to send your cashback and rewards, I'll need your *EVM wallet address*:\n\n\`/setwallet 0xYourAddress\`\n\n` +
      `_Don't have one? Create a free wallet on MetaMask or Coinbase Wallet._`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Onboarding: awaiting wallet (nudge them to use /setwallet) ───────────
  if (profile.onboarding === "awaiting_wallet") {
    // Check if they pasted a raw wallet address without the command
    if (EVM_ADDRESS_RE.test(text)) {
      updateProfile(userId, { wallet: text, onboarding: "complete" });
      await ctx.reply(
        `✅ *Wallet saved!*\n\`${text}\`\n\n` +
        `You're all set 🎉 Tell me where you want to go or what you want to buy!`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    await ctx.reply(
      `Almost there! I just need your EVM wallet address to send you cashback:\n\n\`/setwallet 0xYourAddress\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Fully onboarded — pass to agent ─────────────────────────────────────
  await ctx.replyWithChatAction("typing");
  try {
    const reply = await processMessage(userId, text, profile.wallet ?? "", profile.country);
    await sendLongMessage(ctx, reply);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unexpected error";
    console.error(`[bot] error for user ${userId}:`, errMsg);
    await ctx.reply(
      `⚠️ Something went wrong:\n\`${errMsg}\`\n\nTry again or use /new to reset.`,
      { parse_mode: "Markdown" }
    );
  }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot] unhandled error for update ${ctx.update.update_id}:`);
  if (err.error instanceof GrammyError) console.error("Grammy error:", err.error.description);
  else if (err.error instanceof HttpError) console.error("HTTP error:", err.error);
  else console.error("Unknown error:", err.error);
});

// ---------------------------------------------------------------------------
// Health check server (Render free tier requires a listening port)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
createServer((_, res) => { res.writeHead(200); res.end("OK"); })
  .listen(PORT, () => console.log(`[bot] Health check on port ${PORT}`));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log("[bot] Starting Opi…");
bot.start({ onStart: (info) => console.log(`[bot] Listening as @${info.username} (id: ${info.id})`) });
