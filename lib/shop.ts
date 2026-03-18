/**
 * shop.ts — Interactive /shop command with Telegram inline buttons
 *
 * Flow:
 *   /shop → Category grid → Merchant list → Merchant detail + "Get Link" button
 *
 * Callback data format:
 *   shop:cat:{categoryName}       — User picked a category
 *   shop:merchant:{merchantId}    — User picked a merchant
 *   shop:mint:{merchantId}        — User wants the affiliate link
 *   shop:back                     — Back to categories
 */

import { Context, Markup } from 'telegraf';
import {
  getCategoryNames,
  getMerchantsByCategory,
  findMerchantById,
  mintLink,
  type Merchant,
} from './laguna';
import { getSession } from './store';

// ─── Category Emojis ────────────────────────────────────────────────────

const CATEGORY_EMOJI: Record<string, string> = {
  'Travel': '✈️',
  'Fashion': '👗',
  'Shopping': '🛒',
  'Tech & Gaming': '🎮',
  'Luxury & Lifestyle': '💎',
};

// ─── /shop Entry Point ──────────────────────────────────────────────────

export async function handleShopCommand(ctx: Context) {
  const categories = getCategoryNames();

  const buttons = categories.map((cat) => [
    Markup.button.callback(
      `${CATEGORY_EMOJI[cat] || '📦'} ${cat}`,
      `shop:cat:${cat}`
    ),
  ]);

  // Add a search hint row
  buttons.push([
    Markup.button.callback('🔍 Search by name', 'shop:search'),
  ]);

  await ctx.reply(
    '🏪 <b>Nexus Shopping Mall</b>\n\n' +
      'Browse categories below to find merchants with USDC cashback rewards.\n' +
      'Your rewards go straight to your vault.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    }
  );
}

// ─── Category → Merchant List ───────────────────────────────────────────

async function showCategoryMerchants(ctx: Context, category: string) {
  const merchants = getMerchantsByCategory(category);

  if (merchants.length === 0) {
    await ctx.answerCbQuery('No merchants found in this category.');
    return;
  }

  const buttons = merchants.map((m) => [
    Markup.button.callback(
      `${m.name}  •  up to ${m.bestRate}% cashback`,
      `shop:merchant:${m.id}`
    ),
  ]);

  buttons.push([Markup.button.callback('⬅️ Back to categories', 'shop:back')]);

  const emoji = CATEGORY_EMOJI[category] || '📦';
  const text =
    `${emoji} <b>${category}</b>\n\n` +
    `${merchants.length} merchants available. Tap one for details:`;

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
  await ctx.answerCbQuery();
}

// ─── Merchant Detail ────────────────────────────────────────────────────

async function showMerchantDetail(ctx: Context, merchantId: string) {
  const merchant = findMerchantById(merchantId);

  if (!merchant) {
    await ctx.answerCbQuery('Merchant not found.');
    return;
  }

  const geoList =
    merchant.availableCountries.length > 0
      ? merchant.availableCountries.slice(0, 8).join(', ') +
        (merchant.availableCountries.length > 8 ? '…' : '')
      : 'Global';

  const text =
    `🏷️ <b>${merchant.name}</b>\n\n` +
    `💰 Cashback: up to <b>${merchant.bestRate}%</b>\n` +
    `🌍 Available in: ${geoList}\n\n` +
    `Tap "Get Reward Link" below to generate your personal affiliate link.\n` +
    `USDC cashback will be routed to your vault.`;

  const buttons = [
    [Markup.button.callback('🔗 Get Reward Link', `shop:mint:${merchantId}`)],
    [
      Markup.button.callback(
        `⬅️ Back to ${merchant.category || 'categories'}`,
        merchant.category ? `shop:cat:${merchant.category}` : 'shop:back'
      ),
    ],
  ];

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
  await ctx.answerCbQuery();
}

// ─── Mint Link (Sovereign Reward Routing) ───────────────────────────────

async function handleMintLink(ctx: Context, merchantId: string) {
  const userId = ctx.from?.id?.toString();
  if (!userId) {
    await ctx.answerCbQuery('Could not identify your account.');
    return;
  }

  await ctx.answerCbQuery('Generating your personal reward link…');

  const session = await getSession(userId);
  const vaultAddress = session?.vault_address || null;
  const geo = session?.geo || null;

  if (!vaultAddress) {
    await ctx.editMessageText(
      '⚠️ <b>Vault not set</b>\n\n' +
        'You need to set your EVM wallet address first so rewards can be routed to you.\n\n' +
        'Run: <code>/setvault 0xYourAddress</code>\n\n' +
        'Then try /shop again.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  try {
    const link = await mintLink(merchantId, vaultAddress, geo);
    const merchant = findMerchantById(merchantId);

    await ctx.editMessageText(
      `✅ <b>Reward Link Ready</b>\n\n` +
        `🏷️ ${merchant?.name || merchantId}\n` +
        `💰 Up to ${link.bestRate}% cashback in USDC\n` +
        `🔑 Vault: <code>${vaultAddress.slice(0, 6)}…${vaultAddress.slice(-4)}</code>\n\n` +
        `👇 <b>Shop here to earn rewards:</b>\n` +
        `${link.shortlink}\n\n` +
        `<i>Cashback is tracked automatically via this link.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('🛍️ Open Shop', link.shortlink)],
          [Markup.button.callback('🏪 Browse More', 'shop:back')],
        ]),
      }
    );
  } catch (err) {
    console.error('[Laguna] mint_link failed:', err);
    await ctx.editMessageText(
      '❌ Could not generate reward link. Please try again in a moment.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Retry', `shop:mint:${merchantId}`)],
          [Markup.button.callback('🏪 Browse More', 'shop:back')],
        ]),
      }
    );
  }
}

// ─── Callback Query Router ──────────────────────────────────────────────

export async function handleShopCallback(ctx: Context): Promise<boolean> {
  const cbQuery = ctx.callbackQuery;
  if (!cbQuery || !('data' in cbQuery)) return false;

  const data = cbQuery.data;
  if (!data || !data.startsWith('shop:')) return false;

  const parts = data.split(':');
  const action = parts[1];
  const value = parts.slice(2).join(':'); // Handle category names with colons

  switch (action) {
    case 'back':
      // Re-render the category grid
      const categories = getCategoryNames();
      const buttons = categories.map((cat) => [
        Markup.button.callback(
          `${CATEGORY_EMOJI[cat] || '📦'} ${cat}`,
          `shop:cat:${cat}`
        ),
      ]);
      await ctx.editMessageText(
        '🏪 <b>Nexus Shopping Mall</b>\n\nBrowse categories below:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(buttons),
        }
      );
      await ctx.answerCbQuery();
      break;

    case 'cat':
      await showCategoryMerchants(ctx, value);
      break;

    case 'merchant':
      await showMerchantDetail(ctx, value);
      break;

    case 'mint':
      await handleMintLink(ctx, value);
      break;

    case 'search':
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        '🔍 <b>Search Merchants</b>\n\n' +
          'Type your search as a message, like:\n' +
          '<code>Nike</code> or <code>flights to Tokyo</code>\n\n' +
          'I\'ll find matching merchants with cashback rewards.',
        { parse_mode: 'HTML' }
      );
      break;

    default:
      await ctx.answerCbQuery('Unknown action');
  }

  return true;
}
