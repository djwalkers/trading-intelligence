# Build 0.1.0 — Trading Intelligence Platform Prototype

Date: 2026-07-07
Location: `Trading/platform/web`

## What was built

The first usable product prototype: a dark-themed Next.js (App Router) + TypeScript + Tailwind
CSS web dashboard, running entirely on mock data.

Pages:

- **Dashboard** — market status, paper portfolio value, today's P/L, active strategies, latest
  signals, watchlist snapshot, system health summary.
- **Watchlist** — Apple, Microsoft, Tesla, Nvidia, S&P 500 ETF with price/change/volume.
- **Signals** — mock BUY/SELL/HOLD signals with confidence %, strategy name, reason, timestamp.
- **Paper Portfolio** — simulated portfolio starting at £10,000, current value, daily P/L, total
  return %, and open mock positions.
- **Strategies** — mock rule-based strategies (Momentum Breakout, Mean Reversion, Trend
  Following, Volatility Filter) with status and recent signal counts.
- **System Health** — Market Data (Mocked), Broker API (Not Connected), Database (Not Connected),
  Strategy Engine (Running), Risk Engine (Passive), Execution Engine (Disabled).

Supporting structure: typed domain models (`src/lib/types`), mock data separated from UI
(`src/lib/mock`), reusable layout and table components, and a project README with setup
instructions.

## What is intentionally not included yet

- Authentication or user accounts
- A database or any persistence layer (Supabase or otherwise)
- A real broker or market data connection
- AI-generated signals or agents
- Live or simulated order execution against a broker
- Financial advice or profit-claim language of any kind

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open `http://localhost:3000`. Run `npm run build` to verify a production build.

## Next recommended build (0.2.0)

Introduce a persistence layer (Supabase) to store watchlists, strategy configuration, and paper
portfolio state server-side, replacing the in-memory mock data with a thin data-access layer —
while keeping the UI contract (types in `src/lib/types`) unchanged so the switch is additive, not
a rewrite.
