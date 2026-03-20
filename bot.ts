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
// Per-user wallet store  (in-memory; swap for Redis/SQLite in production)
// ---------------------------------------------------------------------------

const wallets = new Map<number, string>(); // userId → "0x..."

function getWallet(userId: number): string | undefined {
  return wallets.get(userId);
}

function setWallet(userId: number, address: string) {
  wallets.set(userId, address);
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
  await ctx.reply(
    `👋 *Welcome to Nexus — your AI shopping agent!*\n\n` +
      `I find the best deals and generate *affiliate links* for retail & travel. ` +
      `Every time someone books or buys through your link, you earn *USDC* directly to your wallet.\n\n` +
      `*To get started, set your wallet address:*\n` +
      `/setwallet 0xYourEVMAddressHere\n\n` +
      `Then just tell me what you're looking for, e.g.:\n` +
      `• "Best flights to Tokyo in April"\n` +
      `• "Wireless headphones under $80"\n` +
      `• "Cashback on Nike or Adidas"\n\n` +
      `Other commands:\n` +
      `/mywallet — show your saved wallet\n` +
      `/dashboard — check your USDC earnings\n` +
      `/new — clear conversation and start fresh`,
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
      `⚠️ Please provide a valid EVM wallet address.\n\n` +
        `Example:\n\`/setwallet 0xAbCd...1234\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  setWallet(userId, address);
  await ctx.reply(
    `✅ Wallet saved!\n\n\`${address}\`\n\n` +
      `Affiliate links I generate will credit USDC to this address. ` +
      `Now tell me what you want to shop for!`,
    { parse_mode: "Markdown" }
  );
});

// ---------------------------------------------------------------------------
// /mywallet
// ---------------------------------------------------------------------------

bot.command("mywallet", async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const wallet = getWallet(userId);
  if (!wallet) {
    await ctx.reply(
      `No wallet set yet. Use:\n\`/setwallet 0xYourAddress\``,
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.reply(`Your wallet: \`${wallet}\``, { parse_mode: "Markdown" });
  }
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

  const wallet = getWallet(userId);
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
// Main message handler
// ---------------------------------------------------------------------------

bot.on("message:text", async (ctx: Context) => {
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!userId || !text) return;

  // Prompt wallet setup if not set yet
  const wallet = getWallet(userId);
  if (!wallet) {
    await ctx.reply(
      `Before I can generate affiliate links for you, I need your EVM wallet address so you earn the USDC commissions.\n\n` +
        `\`/setwallet 0xYourAddress\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.replyWithChatAction("typing");

  try {
    const reply = await processMessage(userId, text, wallet);
    await ctx.reply(reply, { parse_mode: "Markdown" });
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

console.log("[bot] Starting Nexus Gateway…");
bot.start({
  onStart: (info) =>
    console.log(`[bot] Listening as @${info.username} (id: ${info.id})`),
});
