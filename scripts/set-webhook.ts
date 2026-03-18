/**
 * Utility script to register the Telegram webhook.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx VERCEL_URL=your-app.vercel.app npx ts-node scripts/set-webhook.ts
 */

import axios from 'axios';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const domain = process.env.VERCEL_URL;

  if (!token || !domain) {
    console.error('Set TELEGRAM_BOT_TOKEN and VERCEL_URL environment variables.');
    process.exit(1);
  }

  const webhookUrl = `https://${domain}/api/webhook`;

  const res = await axios.get(
    `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
  );

  console.log('Webhook set:', res.data);
  console.log(`URL: ${webhookUrl}`);
}

main().catch(console.error);
