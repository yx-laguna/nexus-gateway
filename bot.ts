/**
 * bot.ts
 *
 * Telegram bot entry point built with grammY.
 *
 * Each user registers their own EVM wallet address via /setwallet.
 * Affiliate links minted by Laguna are tied to that address, so USDC
 * commissions flow directly to the user — not to a shared operator wallet.
 *
 * Commands:
 *   /start       – welcome message and usage hint
 *   /setwallet   – save the user's EVM wallet address
 *   /mywallet    – show the currently saved wallet
 *   /new         – clear conversation history
 *   /dashboard   – fetch Laguna earnings for the user's wallet
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
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Exiting.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Per-user profile store — wallet + country, persisted to profiles.json
// ---------------------------------------------------------------------------

interface UserProfile {
  wallet?: string;
  country?: string; // ISO 3166-1 alpha-2, e.g. "SG", "US"
}

const PROFILES_FILE = "./profiles.json";

function loadProfiles(): Map<number, UserProfile> {
  try {
    const raw = readFileSync(PROFILES_FILE, "utf8");
    return new Map(
      Object.entries(JSON.parse(raw)).map(([k, v]) => [Number(k), v as UserProfile])
    );
  } catch {
    return new Map();
  }
}

function saveProfiles(map: Map<number, UserProfile>) {
  writeFileSync(PROFILES_FILE, JSON.stringify(Object.fromEntries(map)), "utf8");
}

const profiles = loadProfiles();
console.log(`[bot] Loaded ${profiles.size} saved profile(s)`);

function getProfile(userId: number): UserProfile {
  return profiles.get(userId) ?? {};
}

function updateProfile(userId: number, update: Partial<UserProfile>) {
  const existing = getProfile(userId);
  profiles.set(userId, { ...existing, ...update });
  saveProfiles(profiles);
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Converts country name or code to ISO alpha-2
const COUNTRY_MAP: Record<string, string> = {
  "singapore": "SG", "malaysia": "MY", "indonesia": "ID", "thailand": "TH",
  "philippines": "PH", "vietnam": "VN", "australia": "AU", "japan": "JP",
  "korea": "KR", "china": "CN", "india": "IN", "uk": "GB",
  "united kingdom": "GB", "united states": "US", "usa": "US", "us": "US",
  "uae": "AE", "dubai": "AE", "germany": "DE", "france": "FR",
  "canada": "CA", "hong kong": "HK", "taiwan": "TW",
};

function parseCountry(input: string): string | null {
  const clean = input.trim().toLowerCase();
  // Already a 2-letter code
  if (/^[a-z]{2}$/.test(clean)) return clean.toUpperCase();
  return COUNTRY_MAP[clean] ?? null;
}

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

  await ctx.reply(
    `👋 *Hey! I'm Opi — your personal travel & shopping concierge.*\n\n` +
    `I find the best deals across flights, hotels, and retail — and earn you *USDC cashback* on everything you book or buy.\n\n` +
    `To get started I just need two things:\n\n` +
    `🌍 *Where are you shopping from?*\n` +
    `Reply with your country — e.g. _Singapore_, _Malaysia_, _United States_\n` +
    `(This helps me show you merchants available in your region)\n\n` +
    `💳 *Your EVM wallet address* to receive cashback:\n` +
    `\`/setwallet 0xYourAddress\`\n\n` +
    (profile.country || profile.wallet
      ? `_Your current profile:_\n` +
        (profile.country ? `🌍 Country: *${profile.country}*\n` : `🌍 Country: not set\n`) +
        (profile.wallet ? `💳 Wallet: \`${profile.wallet}\`` : `💳 Wallet: not set`)
      : `_Once both are set, just tell me what you're looking for!_`),
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

  updateProfile(userId, { wallet: address });
  const profile = getProfile(userId);
  await ctx.reply(
    `✅ *Wallet saved!*\n\`${address}\`\n\n` +
    (profile.country
      ? `You're all set! Tell me what you're looking for and I'll find you the best deals + cashback. 🛍️`
      : `One more thing — what country are you shopping from?\nReply with e.g. _Singapore_, _Malaysia_, _United States_`),
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
    await ctx.reply(
      `Please tell me your country. Example:\n\`/setcountry Singapore\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const code = parseCountry(input);
  if (!code) {
    await ctx.reply(
      `⚠️ Couldn't recognise that country. Try using the full name or 2-letter code, e.g.:\n\`/setcountry SG\` or \`/setcountry Singapore\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  updateProfile(userId, { country: code });
  const profile = getProfile(userId);
  await ctx.reply(
    `✅ *Country set to ${code}!*\n\n` +
    (profile.wallet
      ? `You're all set! Tell me what you're looking for and I'll find you the best deals. 🛍️`
      : `Now add your wallet to earn cashback:\n\`/setwallet 0xYourAddress\``),
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /mywallet
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
// /new  — reset session
// ---------------------------------------------------------------------------

bot.command("new", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (userId) clearHistory(userId);
  await ctx.reply("Session cleared. What are you shopping for?");
});

// ---------------------------------------------------------------------------
// /dashboard
// ---------------------------------------------------------------------------

bot.command("dashboard", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const { wallet } = getProfile(userId);
  if (!wallet) {
    await ctx.reply(
      `Set your wallet first so I can look up your earnings:\n\`/setwallet 0xYourAddress\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const msg = await ctx.reply("Fetching your dashboard…");

  try {
    const data = await getDashboard({
      wallet_address: wallet,
      include: ["conversions", "analytics"],
    });

    const balance =
      data.balance !== undefined ? `$${data.balance} USDC` : "N/A";
    const conversions = Array.isArray(data.conversions)
      ? data.conversions.length
      : "N/A";

    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `📊 *Your Nexus Dashboard*\n\n` +
        `💰 Balance: *${balance}*\n` +
        `🔗 Conversions: *${conversions}*\n\n` +
        `Wallet: \`${wallet}\`\n` +
        `_Payouts settle in USDC on Base chain_`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `⚠️ Could not fetch dashboard: ${errMsg}`
    );
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
    // Markdown parse failed — strip formatting and send as plain text
    await ctx.reply(text.replace(/[*_`[\]]/g, ""));
  }
}

async function sendLongMessage(ctx: Context, text: string) {
  if (text.length <= MAX_TG_LENGTH) {
    await sendChunk(ctx, text);
    return;
  }
  // Split on paragraph breaks where possible
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
  for (const chunk of chunks) {
    await sendChunk(ctx, chunk);
  }
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

bot.on("message:text", async (ctx: Context) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!userId || !text) return;

  const profile = getProfile(userId);

  // Auto-detect country reply during onboarding (short message, no wallet yet)
  if (!profile.country && !text.startsWith("/")) {
    const code = parseCountry(text);
    if (code) {
      updateProfile(userId, { country: code });
      await ctx.reply(
        `✅ Got it — shopping from *${code}*!\n\n` +
        (profile.wallet
          ? `You're all set! What are you looking for?`
          : `Now add your wallet to earn cashback:\n\`/setwallet 0xYourAddress\``),
        { parse_mode: "Markdown" }
      );
      return;
    }
  }

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
// Error handling
// ---------------------------------------------------------------------------

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot] unhandled error for update ${ctx.update.update_id}:`);
  if (err.error instanceof GrammyError) {
    console.error("Grammy error:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("HTTP error:", err.error);
  } else {
    console.error("Unknown error:", err.error);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Health check server — required for Render free Web Service tier
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => console.log(`[bot] Health check listening on port ${PORT}`));

// ---------------------------------------------------------------------------
// Start bot
// ---------------------------------------------------------------------------

console.log("[bot] Starting Nexus Gateway…");
bot.start({
  onStart: (info) =>
    console.log(`[bot] Listening as @${info.username} (id: ${info.id})`),
});
