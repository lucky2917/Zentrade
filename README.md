# Zentrade

Paper trading simulator for Indian stock markets. Real NSE prices, virtual money. Practice intraday and delivery trading without risking actual capital.

## The Problem

90% of beginner intraday traders blow up their accounts in the first few months. Not because markets are unfair, but because they go in blind. No experience with order flow, no discipline around stop-losses, no feel for how quickly things move during market hours. They learn the hard way and pay for it with real money.

---

## The Solution

Zentrade puts you in a real trading environment with ₹10,00,000 virtual balance. You trade actual NSE stocks at live prices, track your PnL in real-time, and experience exactly what a real broker feels like. If you blow up here, you just reset and learn. No real damage done.

---

## Stack

- **Frontend** — React, Vite, Socket.io, Lightweight Charts
- **Backend** — Node.js, Express, PostgreSQL, Redis
- **Auth** — Google OAuth + JWT
- **AI** — Groq (Llama 3.3 70B)
- **Docs** — Swagger at `/api-docs`

## Features

- Google OAuth login
- Live NSE prices via Socket.io
- Intraday (MIS 5x leverage) and Delivery (CNC) order modes
- Real-time portfolio PnL
- Order history, watchlist
- AI stock analysis
- Candlestick charts (1D to 1Y)
- Auto square-off at 15:25 IST
- PWA — installable on mobile

## Future Scope

- Limit orders and stop-loss triggers
- Portfolio analytics and daily PnL history
- Price alerts via push notifications
- Leaderboard and trading competitions
- **ZenBot** — an AI agent that reads market news and places real intraday trades autonomously using multi-model consensus (Groq + Gemini + Cerebras). Every user can watch the bot live — which stocks it scanned, how each model voted, and why it traded or skipped.


