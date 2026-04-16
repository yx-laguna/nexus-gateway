# Opi — AI Shopping Concierge on Telegram

> Your personal travel & shopping assistant that finds the best deals and earns you **USDC cashback** — powered by decentralised AI inference.

---

## What is Opi?

Opi is a Telegram bot that acts as a concierge for travel and retail shopping. You tell it what you want — a hotel in Bali, Nike running shoes, a Disney cruise — and it:

1. Breaks your goal into categories with specific recommendations
2. Finds the best merchant from **200+ brands** on the Laguna affiliate network
3. Mints a personalised affiliate link tied to **your** crypto wallet
4. Shows you exactly how much USDC cashback you'll earn on the purchase

No middlemen. Cashback goes directly to your wallet.

---

## How It Works

```
User (Telegram)
      │
      ▼
  [ Opi Bot ]  ── grammY Telegram framework
      │
      ├─ 1. Understands your goal
      │       └── DeepSeek V3 on 0G Compute (decentralised inference)
      │
      ├─ 2. Finds merchants + mints affiliate links
      │       └── Laguna Network MCP (200+ merchants, live cashback rates)
      │
      └─ 3. Replies with ranked picks + affiliate links + cashback estimate
```

### Three integrations

| Layer | Technology | Role |
|---|---|---|
| **AI Inference** | [0G Compute Network](https://0g.ai) | Decentralised LLM inference — DeepSeek V3 processes your shopping goals without relying on centralised AI APIs |
| **Affiliate Network** | [Laguna Network](https://laguna.network) | 200+ merchants (Trip.com, Agoda, Nike, Klook, Shein, IHG and more) — affiliate links are minted on-chain and cashback settles in USDC to your wallet |
| **User Interface** | Telegram Bot (grammY) | Conversational interface — no app download, works in any Telegram client |

---

## Features

- 🌍 **Travel planning** — flights, hotels, activities, cruises, car rentals
- 🛍️ **Retail shopping** — fashion, electronics, health, sports
- 💸 **Real cashback math** — shows `merchant rate × spend = $X USDC` before you click
- 👛 **Your wallet, your cashback** — supports EVM (`0x...`) and TON (`UQ...`) wallets
- 🔗 **Only real links** — every link is minted live via Laguna MCP, never fabricated
- 🌐 **Country-aware** — merchants and rates filtered by your shopping country
- 📊 **Dashboard** — track your affiliate earnings with `/dashboard`

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome + onboarding (set country + wallet) |
| `/setwallet <address>` | Save your EVM or TON wallet address |
| `/setcountry <country>` | Update your shopping country |
| `/mywallet` | View your saved profile |
| `/dashboard` | Check your Laguna cashback earnings |
| `/new` | Clear conversation and start fresh |

---

## Quick Start (Local)

```bash
git clone https://github.com/yx-laguna/nexus-gateway.git
cd nexus-gateway
npm install
cp .env.example .env
# Fill in your keys (see below)
npm run dev
```

### Environment Variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/botfather) on Telegram |
| `ZG_API_KEY` | 0G Compute API key (`app-sk-...`) — get from [0G Compute Marketplace](https://compute.0g.ai) |
| `ZG_ENDPOINT` | 0G Compute provider endpoint URL |
| `ZG_SERVICE_NAME` | Model name, e.g. `deepseek-chat-v3-0324` |
| `LAGUNA_MCP_URL` | Laguna MCP endpoint (default: `https://agents.laguna.network/mcp`) |

---

## Deployment

Deployed as a **Render web service** (Node, Starter plan):

- Bot registers a Telegram webhook automatically on startup using `RENDER_EXTERNAL_URL`
- Webhook handler ACKs Telegram immediately (200 OK) and processes async — no retry storms
- Health check endpoint at `GET /` keeps the service warm

---

## Stack

```
bot.ts      — Telegram bot, onboarding, user profiles (grammY)
agent.ts    — 3-step pipeline: intent → merchant search → reply builder
laguna.ts   — Laguna MCP client (JSON-RPC over HTTP, session management)
broker.ts   — 0G Compute LLM client (OpenAI-compatible, retry + backoff)
```

---

## Built for

This project was built for the **0G × Laguna Hackathon**, demonstrating how decentralised AI inference (0G Compute) and on-chain affiliate infrastructure (Laguna Network) can combine to create a consumer-grade Web3 shopping experience — accessible to anyone with Telegram, no crypto knowledge required.
