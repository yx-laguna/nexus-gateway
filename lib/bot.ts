/**
 * bot.ts — Telegraf bot setup with all commands and handlers
 *
 * Commands:
 *   /start        — Welcome message + onboarding
 *   /setvault     — Set EVM wallet address for reward routing
 *   /setgeo       — Set country code for geo-targeted rates
 *   /vault        — Check current vault status
 *   /shop         — Browse merchants with inline buttons
 *   /search       — Search for specific merchants
 *   /help         — Command reference
 *
 * Text messages → forwarded to Travelshopper HQ Mind for shopping intelligence
 * Callback queries → routed to /shop inline button handler
 */

import { Telegraf, Markup } from 'telegraf';
import { handleShopCommand, handleShopCallback } from './shop';
import { queryMind } from './ethoswarm';
import { searchMerchants, mintLink, findMerchantById } from './laguna';
import {
  getSession,
  upsertSession,
  setVaultAddress,
  setGeo,
  getConversation,
  appendConversation,
  clearConversation,
} from './store';

// ─── Bot Instance ───────────────────────────────────────────────────────

export const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// ─── /start ─────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();

  await upsertSession(userId, {
    username: ctx.from.username || ctx.from.first_name || null,
  });

  await ctx.reply(
    `🟢 <b>Welcome to Nexus Shopping Intelligence</b>\n\n` +
      `I'm your AI shopping assistant powered by on-chain rewards.\n\n` +
      `<b>Get started:</b>\n` +
      `1️⃣ Set your wallet: <code>/setvault 0xYourAddress</code>\n` +
      `2️⃣ Set your country: <code>/setgeo SG</code>\n` +
      `3️⃣ Browse deals: /shop\n\n` +
      `Or just ask me anything about shopping — I'll give you\n` +
      `price intelligence, yield analysis, and cashback-optimized links.\n\n` +
      `<i>Your rewards. Your vault. Your rules.</i>`,
    { parse_mode: 'HTML' }
  );
});

// ─── /setvault ──────────────────────────────────────────────────────────

bot.command('setvault', async (ctx) => {
  const userId = ctx.from.id.toString();
  const address = ctx.message.text.split(' ')[1]?.trim();

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    await ctx.reply(
      '⚠️ Please provide a valid EVM address.\n\n' +
        'Example: <code>/setvault 0x1234567890abcdef1234567890abcdef12345678</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await setVaultAddress(userId, address);

  await ctx.reply(
    `✅ <b>Vault saved</b>\n\n` +
      `Address: <code>${address.slice(0, 6)}…${address.slice(-4)}</code>\n\n` +
      `All USDC cashback from your purchases will be routed here.\n` +
      `Use /shop to start earning.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /setgeo ────────────────────────────────────────────────────────────

bot.command('setgeo', async (ctx) => {
  const userId = ctx.from.id.toString();
  const geo = ctx.message.text.split(' ')[1]?.trim()?.toUpperCase();

  if (!geo || geo.length !== 2) {
    await ctx.reply(
      '⚠️ Please provide a 2-letter country code.\n\n' +
        'Example: <code>/setgeo SG</code> (Singapore)\n' +
        'Example: <code>/setgeo US</code> (United States)',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await setGeo(userId, geo);
  await ctx.reply(
    `🌍 Country set to <b>${geo}</b>. Merchant rates will be filtered for your region.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /vault ─────────────────────────────────────────────────────────────

bot.command('vault', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = await getSession(userId);

  if (!session?.vault_address) {
    await ctx.reply(
      '📭 No vault set yet.\n\nUse <code>/setvault 0xYourAddress</code> to enable rewards.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const addr = session.vault_address;
  await ctx.reply(
    `🔐 <b>Your Vault</b>\n\n` +
      `Address: <code>${addr}</code>\n` +
      `Country: ${session.geo || 'Not set'}\n\n` +
      `All cashback rewards are routed to this wallet.`,
    { parse_mode: 'HTML' }
  );
});

// ─── /shop ──────────────────────────────────────────────────────────────

bot.command('shop', handleShopCommand);

// ─── /search ────────────────────────────────────────────────────────────

bot.command('search', async (ctx) => {
  const userId = ctx.from.id.toString();
  const query = ctx.message.text.replace('/search', '').trim();

  if (!query) {
    await ctx.reply(
      '🔍 What are you looking for?\n\n' +
        'Example: <code>/search Nike</code>\n' +
        'Example: <code>/search hotels Singapore</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const session = await getSession(userId);
  const merchants = await searchMerchants(query, session?.geo);

  if (merchants.length === 0) {
    await ctx.reply(`No merchants found for "${query}". Try a different search term.`);
    return;
  }

  const lines = merchants.map(
    (m, i) => `${i + 1}. <b>${m.name}</b> — up to ${m.bestRate}% cashback`
  );

  const buttons = merchants.slice(0, 8).map((m) => [
    Markup.button.callback(
      `${m.name} (${m.bestRate}%)`,
      `shop:merchant:${m.id}`
    ),
  ]);

  await ctx.reply(
    `🔍 <b>Results for "${query}"</b>\n\n${lines.join('\n')}\n\nTap a merchant for details:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    }
  );
});

// ─── /reset ─────────────────────────────────────────────────────────────

bot.command('reset', async (ctx) => {
  const userId = ctx.from.id.toString();
  await clearConversation(userId);
  await ctx.reply('🔄 Conversation history cleared. Fresh start!');
});

// ─── /help ──────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 <b>Nexus Commands</b>\n\n` +
      `<code>/setvault 0x…</code> — Set your EVM wallet for USDC rewards\n` +
      `<code>/setgeo SG</code> — Set your country for region-specific rates\n` +
      `<code>/vault</code> — Check your current vault status\n` +
      `<code>/shop</code> — Browse merchant categories with cashback\n` +
      `<code>/search Nike</code> — Search for a specific merchant\n` +
      `<code>/reset</code> — Clear conversation history\n\n` +
      `Or just send me a message like:\n` +
      `<i>"I want to book a hotel in Bangkok"</i>\n` +
      `<i>"Best deals on sneakers right now?"</i>\n\n` +
      `I'll analyze your request and give you intelligence-rated recommendations with reward links.`,
    { parse_mode: 'HTML' }
  );
});

// ─── Inline Button Callbacks ────────────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  try {
    const handled = await handleShopCallback(ctx);
    // If the callback wasn't handled by the shop module, answer it
    // to prevent Telegram client timeout spinners
    if (!handled) {
      await ctx.answerCbQuery();
    }
  } catch (err) {
    console.error('[Shop Callback] Error:', err);
    try {
      await ctx.answerCbQuery('Something went wrong. Try again.');
    } catch {
      // answerCbQuery may fail if already answered or timed out
    }
  }
});

// ─── Free-Text Messages → Mind (RaaS) ──────────────────────────────────

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userMsg = ctx.message.text;

  // Ensure session exists
  const session = await upsertSession(userId, {
    username: ctx.from.username || ctx.from.first_name || null,
  });

  // Get conversation history for multi-tenant context
  const history = await getConversation(userId);

  // Send typing indicator
  await ctx.sendChatAction('typing');

  // Query the Mind (Travelshopper HQ)
  const mindResponse = await queryMind(userMsg, session, history);

  // Save conversation turns
  await appendConversation(userId, 'user', userMsg);
  await appendConversation(userId, 'assistant', mindResponse.reply);

  // If the Mind detected merchant intent and user has a vault,
  // try to auto-generate affiliate links for mentioned merchants
  if (mindResponse.merchants && mindResponse.merchants.length > 0 && session.vault_address) {
    const linkButtons = [];

    for (const mid of mindResponse.merchants.slice(0, 3)) {
      try {
        const link = await mintLink(mid, session.vault_address, session.geo);
        const merchant = findMerchantById(mid);
        linkButtons.push([
          Markup.button.url(
            `🛍️ ${merchant?.name || mid} (${link.bestRate}% cashback)`,
            link.shortlink
          ),
        ]);
      } catch {
        // Skip failed link generation
      }
    }

    if (linkButtons.length > 0) {
      // Send Mind response with affiliate link buttons
      await ctx.reply(mindResponse.replyHTML || mindResponse.reply, {
        parse_mode: mindResponse.replyHTML ? 'HTML' : undefined,
        ...Markup.inlineKeyboard(linkButtons),
      });
      return;
    }
  }

  // Send Mind response (plain)
  try {
    await ctx.reply(mindResponse.replyHTML || mindResponse.reply, {
      parse_mode: mindResponse.replyHTML ? 'HTML' : undefined,
    });
  } catch {
    // Fallback if HTML parsing fails
    await ctx.reply(mindResponse.reply);
  }
});
