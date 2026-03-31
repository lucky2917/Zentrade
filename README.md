# Project Name - Zentrade

## What it is
so basically zentrade is a full-stack paper trading simulator. built to feel exactly like a real stock broker but powered by fake virtual money. you get real-time market data, live charts, portfolio tracking, and instant order execution. all running on a solid node/postgres/redis backend with a slick react frontend.

## Problem
look, facts say 90% of beginner intraday traders lose their capital in the initial days. they jump into the real market with zero experience, panic sell when they see red, and blow up their accounts. they need a place to practice strategies and get the feel of real market hours without actually going bankrupt.

## Solution
zentrade is the exact sandbox for that. you get ₹10,00,000 virtual balance as soon as you step in. you can buy, sell, watch top movers, see your PnL jump around in real-time, and get used to how actual trading terminals work. if you lose all the money here, you just learn and adjust your strategy instead of losing your actual life savings.

## Status
just pushed the latest commit: **[main 59bd526] after all i rebuilt login.jsx and signup.jsx with continue with google, updated auth.js with /api/auth/google to route between new or old user via access token, updated nav with user name and updated db accordingly moreover css is perfectly fine for current changes my next chnages would be testing completelt and add small comps which i have missed from indrustry applications**
platform is stable, oauth works, real-time data streaming is super smooth.

## Tech Stack
* frontend: react, vite, framer-motion for that butter smooth ui, lucide-react, lightweight-charts
* backend: node.js, express, socket.io (for those live ticking prices)
* DBs: postgres for locking down your financial state (balance, orders, portfolio) and redis to cache the live market prices so the server doesn't choke.

## Features
* **Google OAuth**: one-click "continue with google" login, or classic email/password if u prefer.
* **Live Market Dash**: dynamic dashboard showing top gainers, losers, and most active stocks.
* **Real-time Price Engine**: powers your portfolio PnL and stock detail pages with live yahoo finance data.
* **Instant Orders**: buy/sell panel that calculates brokerage and updates ur virtual balance instantly, exactly like real brokers.
* **Interactive Charts**: switch between 1d, 5d, 1mo, etc ranges built right into the app.
* **Dark/Light Mode**: full glassmorphism UI with a custom theme context switcher so u don't burn ur eyes at night. 

## Roadmap
what's next on the plate:
* gonna do some heavy testing of the complete flow to make sure nothing breaks under load
* adding small industry standard components that are missing right now (like limit orders, stop-loss, market depth panel)
* adding more detailed portfolio analytics so u can truly track ur progress.
