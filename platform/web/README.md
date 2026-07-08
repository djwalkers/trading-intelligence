# Trading Intelligence — Web Prototype

Build 0.9.0. A dark-themed prototype for a trading intelligence platform, built with Next.js
(App Router), TypeScript, and Tailwind CSS. The platform's philosophy: **understand first, decide
second, trade last** — every recommendation explains its reasoning and what would change it.
Market, signal, and strategy data is mocked — there is no broker connection and no live trading.
Paper trades are persisted through a storage-agnostic abstraction: `localStorage` by default, or
Supabase when configured (see [Persistence mode](#persistence-mode) below) — either way the app
looks and behaves identically. "Trading Intelligence" is a temporary product name for this
prototype phase.

## Getting started

Requires Node.js 18.18+ (LTS recommended).

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts:

```bash
npm run build   # production build
npm run start   # serve the production build
npm run lint    # lint the project
```

## What's included

- **Dashboard** — market status, paper portfolio value, today's P/L, active strategies, a paper
  trading performance summary (open/closed trades, realised/unrealised P/L), an Intelligence
  Summary card (highest-scoring opportunity, average score, Excellent/monitor-only counts),
  latest signals, watchlist snapshot, and system health summary.
- **Market Intelligence** — the flagship screen. Market Overview (regime, confidence, volatility,
  risk), a ranked Opportunities list, and — for the selected opportunity — a Decision Breakdown
  (five-factor star rating), an Intelligence Score (0–100 across seven factors) with an "Explain
  score" breakdown of what helped and hurt it, a Strong Buy → Strong Sell recommendation with a
  plain-language explanation, a "Why this recommendation?" evidence list, and a "What could
  change?" list of factors that would invalidate the call. Strong Buy / Buy / Strong Sell
  recommendations have a "Paper Trade" action; Hold and Avoid do not. Tick up to 3 opportunities
  to compare them side by side.
- **Watchlist** — tracked instruments with price, change, day range, and volume, plus a Watchlist
  Health summary (Excellent / Good / Weak / Avoid-monitor counts by Intelligence Score).
- **Signals** — mock signal feed (BUY / SELL / HOLD) with confidence, strategy, and reasoning.
  BUY/SELL signals have a "Paper Trade" action (HOLD signals are not tradeable).
- **Paper Portfolio** — simulated portfolio starting at £10,000, with open positions, a paper
  trading performance panel (open/closed counts, realised/unrealised/total P/L), and separate
  Open trades / Closed trades sections. Open trades can be closed directly from this page. No
  real execution.
- **Trade Journal** — a full history of every paper trade placed this session, showing whether
  each came from a Signal or Market Intelligence — the latter also show their recommendation,
  evidence, and invalidation factors — plus exit price, close time, and realised P/L once closed.
  Open trades can be closed from here too. Filters: All / Open / Closed / Signals / Market
  Intelligence / BUY / SELL.
- **Strategies** — mock rule-based strategies and their recent signal output.
- **System Health** — status of each platform service (mocked, not connected, running, passive,
  disabled), plus a live Persistence panel: current mode (Local Browser Storage / Supabase),
  connection status, and last synchronisation time.

## Project structure

```
src/
  app/                  Route segments (App Router). One folder per page.
  components/
    layout/              Sidebar, top bar, prototype banner, footer, page shell
    ui/                  Small reusable primitives (badge, stat card, section panel, page header)
    tables/              Shared list/table views used across dashboard + full pages
    trading/              Paper trade open/close confirmation modals, the first-run import
                          modal, Trade Journal view/list/entry
    portfolio/            Paper Portfolio page view (client, reads paper trade state)
    dashboard/             Dashboard-only widgets (paper trading performance, intelligence summary)
    watchlist/             Watchlist-only widgets (Watchlist Health summary)
    system-health/         Live Persistence status panel (mode, connection, last sync)
    market-intelligence/  Market Overview, Opportunities (with compare checkboxes), Decision
                          Breakdown, Intelligence Score display/breakdown, Explain Score,
                          Comparison table, Recommendation, and the reusable evidence bullet list
                          used by "Why?" and "What could change?"
    icons.tsx            Hand-rolled inline SVG icons (no icon library dependency)
  lib/
    types/               TypeScript types for domain models
    mock/                Mock data, kept separate from UI components
    utils/                Formatting, styling, paper-trade P/L, and Intelligence Score calculation
                          helper functions
    state/                Paper trades context (reads/writes through the persistence layer), the
                          shared useCloseTradeFlow hook, and usePersistenceStatus
    persistence/          Storage-agnostic PaperTradeStore interface; LocalStoragePaperTradeStore
                          and SupabasePaperTradeStore implementations; ResilientPaperTradeStore
                          (fallback + status tracking); Supabase-configured detection
```

Mock data lives entirely in `src/lib/mock` and is typed against `src/lib/types`. Pages import
from `@/lib/mock` and pass data into presentational components — there is no mock data or
business logic embedded in page files. Paper trades you place are runtime state held in
`PaperTradesProvider` (`src/lib/state/paper-trades-context.tsx`), which reads and writes through
`getPaperTradeStore()` rather than talking to `localStorage` directly — see below.

## Persistence mode

Paper trades are saved through a small storage-agnostic interface (`PaperTradeStore`,
`src/lib/persistence/paper-trade-store.ts`) with two real implementations —
`LocalStoragePaperTradeStore` and `SupabasePaperTradeStore` — chosen by `getPaperTradeStore()`:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

**Both unset (default): local storage, no configuration needed.** `npm run dev` just works.

**Both set:** the app reads and writes paper trades to Supabase — copy `.env.example` to
`.env.local`, fill these in from your project's API settings, and see
[`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md) for the full walk-through
(create a project, run the migrations, verify the tables). Only the public anon key is ever used,
client-side — never a service role key; access control is delegated to the RLS policies already
in the migrations.

**If Supabase is configured but unreachable**, the app does not break: `ResilientPaperTradeStore`
catches the failure, logs it to the console, falls back to `localStorage` for the rest of the
session (no repeated retries), and shows a small banner — "Persistence unavailable. Falling back
to local storage." — until the next page load. System Health's Persistence panel always reflects
the real, current state: mode, connection, and last synchronisation time.

If this browser already has local paper trades and a freshly-configured Supabase project has
none, a one-time modal offers to import that history — answering either way (Import or Skip)
means it's never asked again on that browser.

The schema itself — real, runnable SQL, not just documentation — lives in `supabase/migrations/`
(five files, numbered in run order) and `supabase/seed.sql` (sample data for manually poking at
the schema; not read by the app). See
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md)
for the schema rationale, and
[`infrastructure/supabase/README.md`](../../infrastructure/supabase/README.md) for the
infrastructure-level overview.

## What's new in 0.9.0

`SupabasePaperTradeStore` is now real, not a placeholder — implemented against the exact schema
from Build 0.7.0 using `@supabase/supabase-js`. `getPaperTradeStore()` genuinely selects Supabase
when configured, local storage otherwise, with automatic, logged fallback if Supabase ever
becomes unreachable mid-session. A one-time import offer moves existing local history into a
freshly-configured, empty Supabase project. System Health's persistence status is now live rather
than mocked. Nothing changes visually for anyone not using Supabase. See
[`../../docs/product/BUILD-0.9.0.md`](../../docs/product/BUILD-0.9.0.md) for full details.

## What's new in 0.8.0

An Intelligence Score (0–100, seven factors: Trend, Momentum, Volume, Volatility, Market Context,
Risk, Reward) for every Market Intelligence opportunity, with a rule-based "Explain score" section,
a side-by-side comparison of up to 3 opportunities, a Watchlist Health summary, and a Dashboard
Intelligence Summary card. Mock and deterministic throughout — no AI, no live data. See
[`../../docs/product/BUILD-0.8.0.md`](../../docs/product/BUILD-0.8.0.md) for full details.

## What's new in 0.7.0

Turns Build 0.6.0's markdown schema plan into real, runnable SQL: five migration files
(`paper_trades`, `trade_intelligence`, `trade_events`, indexes, and Row Level Security
placeholders), a seed file with sample trades, a hands-on setup guide, and an infrastructure
README. App behaviour is unchanged — still `localStorage`, still zero required environment
variables, still no Supabase network calls possible. See
[`../../docs/product/BUILD-0.7.0.md`](../../docs/product/BUILD-0.7.0.md) for full details.

## What's new in 0.6.0

Prepares the codebase for Supabase persistence without adding a live connection. Paper trades now
flow through a `PaperTradeStore` abstraction instead of calling `localStorage` directly; a
Supabase implementation is stubbed but never selected; System Health reports persistence mode and
Supabase configuration status; and the full target schema is documented. See
[`../../docs/product/BUILD-0.6.0.md`](../../docs/product/BUILD-0.6.0.md) for full details.

## What's new in 0.5.0

Open paper trades can now be closed, producing a realised P/L. Every instrument has a small, fixed
mock price drift so closing a trade shows a real (non-zero) gain or loss, without ever touching
the Watchlist or any other price display. Dashboard, Paper Portfolio, and Trade Journal all show
realised/unrealised/total P/L. See
[`../../docs/product/BUILD-0.5.0.md`](../../docs/product/BUILD-0.5.0.md) for full details.

## What's new in 0.4.0

Market Intelligence and paper trading are now one workflow, not two. Placing a trade from a Strong
Buy/Buy/Strong Sell recommendation reuses the existing risk warning modal and trade context (no
second trade system), and carries the opportunity's evidence onto the resulting trade. Trade
Journal now shows each trade's source and lets you filter by it. See
[`../../docs/product/BUILD-0.4.0.md`](../../docs/product/BUILD-0.4.0.md) for full details.

## What's new in 0.3.0

A new flagship page, Market Intelligence, shifting the platform from a dashboard toward an
evidence-driven analytical assistant. Every recommendation shows its supporting evidence and what
would invalidate it — see
[`../../docs/product/BUILD-0.3.0.md`](../../docs/product/BUILD-0.3.0.md) for full details.

## What's new in 0.2.0

Turns the dashboard into an interactive paper-trading prototype using local browser state only:
a "Paper Trade" action on BUY/SELL signals, a risk warning confirmation modal, paper trades
persisted to `localStorage`, an updated Paper Portfolio page with a "Recent paper trades" section,
and a new Trade Journal page. See
[`../../docs/product/BUILD-0.2.0.md`](../../docs/product/BUILD-0.2.0.md) for full details.

## What's new in 0.1.1

A UI refinement pass on top of 0.1.0 — no new pages or data. Highlights: smaller, balanced sidebar
icons; a compact logo/title area; a "Prototype mode" banner and a lightweight footer showing the
build number and data mode; tighter table row spacing; and a smoother responsive layout across
laptop-sized screens (the four-column stat grids and the two-column dashboard layout now activate
at `lg` instead of jumping straight to `xl`).

## Design intent

Calm, evidence-driven, professional. Dark theme with restrained accent colours (teal for
positive/active states, amber for caution/passive states, red for negative states, blue for
informational states). No crypto or gambling visual language, no profit claims. On Market
Intelligence specifically, colour is reserved for the two recommendation extremes (Strong Buy /
Strong Sell) and star ratings are monochrome — conviction is meant to read through layout and the
amount of supporting evidence, not colour intensity. The Intelligence Score follows the same rule:
plain monochrome bars, colour only on the two score-band extremes (Excellent / Avoid).

## Explicitly out of scope for this build

- Authentication (Supabase RLS policies remain permissive placeholders until auth exists)
- Real broker/market data connections
- Real-time sync or multi-tab updates from Supabase (data loads once per page load, not polled)
- Automatic reconnection within a session after falling back to local storage (reload the page
  to try Supabase again)
- A deployed/linked Supabase project or CI for running migrations
- Partial trade closes, position netting, or live/scheduled price movement
- Real market data, technical indicators, or model-generated scoring behind Market Intelligence or
  the Intelligence Score
- Persistence of Intelligence Scores at the time a trade was opened (scores are computed from
  mock data on every render, not stored on the trade)
- AI-generated signals or agents
- Live order execution
- Financial advice of any kind

See [`../../docs/product/BUILD-0.1.0.md`](../../docs/product/BUILD-0.1.0.md),
[`../../docs/product/BUILD-0.1.1.md`](../../docs/product/BUILD-0.1.1.md),
[`../../docs/product/BUILD-0.2.0.md`](../../docs/product/BUILD-0.2.0.md),
[`../../docs/product/BUILD-0.3.0.md`](../../docs/product/BUILD-0.3.0.md),
[`../../docs/product/BUILD-0.4.0.md`](../../docs/product/BUILD-0.4.0.md),
[`../../docs/product/BUILD-0.5.0.md`](../../docs/product/BUILD-0.5.0.md),
[`../../docs/product/BUILD-0.6.0.md`](../../docs/product/BUILD-0.6.0.md),
[`../../docs/product/BUILD-0.7.0.md`](../../docs/product/BUILD-0.7.0.md),
[`../../docs/product/BUILD-0.8.0.md`](../../docs/product/BUILD-0.8.0.md), and
[`../../docs/product/BUILD-0.9.0.md`](../../docs/product/BUILD-0.9.0.md) for the full build
records; [`../../docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md)
and [`../../docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md) for the
schema and setup guide; and
[`../../sprints/sprint-001/SPRINT-001.md`](../../sprints/sprint-001/SPRINT-001.md) for sprint notes
and the next recommended build.
