/**
 * api/webhook.ts — Vercel serverless handler for Telegram webhook
 *
 * This is the single entry point. Telegram sends POST requests here
 * for every update (message, callback query, etc.).
 *
 * Setup:
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<YOUR_DOMAIN>/api/webhook"
 */

import { VercelRequest, VercelResponse } from '@vercel/node';
import { bot } from '../lib/bot';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(200).json({ status: 'Nexus Gateway is running', method: req.method });
    return;
  }

  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Webhook] Error handling update:', err);
    // Always return 200 to Telegram to prevent retry storms
    res.status(200).send('OK');
  }
}
