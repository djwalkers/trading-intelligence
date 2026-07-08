# Trading Intelligence — Web Prototype

Build 1.1.0. A dark-themed prototype for a trading intelligence platform, built with Next.js
(App Router), TypeScript, and Tailwind CSS. The platform's philosophy: **understand first, decide
second, trade last** — every recommendation explains its reasoning and what would change it.
Signal and strategy data is mocked — there is no broker connection and no live trading. Paper
trades are persisted through a storage-agnostic abstraction: `localStorage` by default, or Supabase
when configured (see [Persistence mode](#persistence-mode) below). Instrument prices flow through a
similar storage-agnostic abstraction: mock data by default, or a live external market data provider
when configured (see [Market data mode](#market-data-mode) below). When Supabase is configured, the
whole app additionally requires sign-in, and paper trades are scoped to the signed-in user (see
[Authentication](#authentication) below) — in local prototype mode (no env vars), none of this
applies and the app behaves exactly as before. "Trading Intelligence" is a temporary product name
for this prototype phase.

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
- **Watchlist** — tracked instruments with current price, daily change (value + percent), day
  range, volume, a last-updated timestamp, and a Mock/External data source badge, plus a Watchlist
  Health summary (Excellent / Good / Weak / Avoid-monitor counts by Intelligence Score).
- **Signals** — mock signal feed (BUY / SELL / HOLD) with confidence, strategy, and reasoning.
  BUY/SELL signals have a "Paper Trade" action (HOLD signals are not tradeable).
- **Paper Portfolio** — simulated portfolio starting at £10,000, with open positions, a paper
  trading performance panel (open/closed counts, realised/unrealised/total P/L, valued through the
  market data provider), and separate Open trades / Closed trades sections showing each open
  trade's current market price. Open trades can be closed directly from this page. No real
  execution.
- **Trade Journal** — a full history of every paper trade placed this session, showing whether
  each came from a Signal or Market Intelligence — the latter also show their recommendation,
  evidence, and invalidation factors — plus exit price, close time, and realised P/L once closed.
  Open trades can be closed from here too. Filters: All / Open / Closed / Signals / Market
  Intelligence / BUY / SELL.
- **Strategies** — mock rule-based strategies and their recent signal output.
- **System Health** — status of each platform service (not connected, running, passive, disabled),
  plus a live Authentication panel (auth enabled/disabled, current user, data scope), a live
  Persistence panel (current mode, connection status, last synchronisation time), and a live
  Market Data panel (provider, connection/mode, last successful refresh, failure reason).
- **Sign in / Sign up** — email/password authentication when Supabase is configured, styled to
  match the app's dark theme. Every other page requires sign-in in that case; local prototype mode
  has no sign-in at all.

## Project structure

```
src/
  app/                  Route segments (App Router). One folder per page.
  components/
    layout/              Sidebar, top bar, prototype banner, footer, page shell, AuthGate
    auth/                 Shared sign-in/sign-up form (AuthForm)
    ui/                  Small reusable primitives (badge, stat card, section panel, page header)
    tables/              Shared list/table views used across dashboard + full pages
    trading/              Paper trade open/close confirmation modals, the first-run import
                          modal, Trade Journal view/list/entry
    portfolio/            Paper Portfolio page view (client, reads paper trade state)
    dashboard/             Dashboard-only widgets (paper trading performance, intelligence summary,
                          market data status)
    watchlist/             Watchlist-only widgets (WatchlistView client wrapper, Watchlist Health
                          summary)
    system-health/         Live Authentication, Persistence, and Market Data status panels
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
    state/                Paper trades context (reads/writes through the persistence layer,
                          re-hydrates on auth identity change), the shared useCloseTradeFlow hook,
                          and usePersistenceStatus
    auth/                 AuthProvider/useAuth() — sign up/in/out, session state, session-expiry
                          detection
    supabase/              getSupabaseClient() (one client shared by auth + persistence),
                          isSupabaseConfigured()
    persistence/          Storage-agnostic PaperTradeStore interface; LocalStoragePaperTradeStore
                          and SupabasePaperTradeStore implementations; ResilientPaperTradeStore
                          (fallback + status tracking); AuthRequiredError
    market-data/          MarketDataProvider interface; MockMarketDataProvider and
                          ExternalMarketDataProvider implementations; ResilientMarketDataProvider
                          (fallback + status tracking); provider-configured detection
```

Mock data lives entirely in `src/lib/mock` and is typed against `src/lib/types`. Pages import
from `@/lib/mock` and pass data into presentational components — there is no mock data or
business logic embedded in page files. Paper trades you place are runtime state held in
`PaperTradesProvider` (`src/lib/state/paper-trades-context.tsx`), which reads and writes through
`getPaperTradeStore()` rather than talking to `localStorage` directly — see below.

## Authentication

When Supabase is configured (see [Persistence mode](#persistence-mode) below), the whole app is
gated behind email/password sign-in via a new `AuthGate` (`src/components/layout/AuthGate.tsx`),
backed by `AuthProvider`/`useAuth()` (`src/lib/auth/auth-context.tsx`). In local prototype mode
(no env vars), there is no auth concept at all — every page renders unconditionally, exactly as
in every prior build.

**Sign up / sign in** at `/sign-up` / `/sign-in` — plain email/password via Supabase Auth, no
OAuth or magic links. **Sign out** is in the sidebar, next to the signed-in user's email.
**Session expiry**: if a signed-in session lapses (rather than the user choosing to sign out), the
sign-in page shows "Your session has expired. Please sign in again."

Paper trades are scoped to the signed-in user, both by explicit filtering in
`SupabasePaperTradeStore` and by Row Level Security server-side (see
[`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md) for the migrations
this requires). If a write is attempted with no session, `SupabasePaperTradeStore` throws a
distinct `AuthRequiredError` that `ResilientPaperTradeStore` recognises and does **not** fall back
to local storage for — silently saving to an unscoped store would be wrong for a user-scoped app.

System Health's Authentication panel always reflects the real, current state: Auth
(Enabled/Disabled), Current user (email, when signed in), and Data scope (User scoped / Local
prototype).

## Persistence mode

Paper trades are saved through a small storage-agnostic interface (`PaperTradeStore`,
`src/lib/persistence/paper-trade-store.ts`) with two real implementations —
`LocalStoragePaperTradeStore` and `SupabasePaperTradeStore` — chosen by `getPaperTradeStore()`:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

**Both unset (default): local storage, no configuration needed, no sign-in.** `npm run dev` just
works.

**Both set:** the app reads and writes paper trades to Supabase, scoped to the signed-in user (see
[Authentication](#authentication) above) — copy `.env.example` to `.env.local`, fill these in from
your project's API settings, and see
[`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md) for the full walk-through
(create a project, run all seven migrations, create an account, verify the tables). Only the
public anon key is ever used, client-side — never a service role key; access control is delegated
to the RLS policies already in the migrations.

**If Supabase is configured but unreachable**, the app does not break: `ResilientPaperTradeStore`
catches the failure, logs it to the console, falls back to `localStorage` for the rest of the
session (no repeated retries), and shows a small banner — "Persistence unavailable. Falling back
to local storage." — until the next page load. System Health's Persistence panel always reflects
the real, current state: mode, connection, and last synchronisation time.

If this browser already has local paper trades and the signed-in user has none in Supabase yet, a
one-time modal offers to import that history — answering either way (Import or Skip) means it's
never asked again on that browser.

The schema itself — real, runnable SQL, not just documentation — lives in `supabase/migrations/`
(seven files, numbered in run order — the first five from Build 0.7.0, plus `user_id` and
user-scoped RLS from Build 1.1.0) and `supabase/seed.sql` (sample data for manually poking at the
schema; not read by the app). See
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md)
for the schema rationale, and
[`infrastructure/supabase/README.md`](../../infrastructure/supabase/README.md) for the
infrastructure-level overview.

## Market data mode

Instrument prices are served through a small storage-agnostic interface (`MarketDataProvider`,
`src/lib/market-data/market-data-provider.ts`) with two real implementations —
`MockMarketDataProvider` and `ExternalMarketDataProvider` — chosen by `getMarketDataProvider()`:

```bash
NEXT_PUBLIC_MARKET_DATA_PROVIDER=
NEXT_PUBLIC_MARKET_DATA_API_KEY=
```

**Both unset (default): mock prices, no configuration needed.** `npm run dev` just works, and
Watchlist/Portfolio/Dashboard/System Health all show a "Mock" source and "Mocked" mode.

**Both set:** the app fetches live quotes from Finnhub's quote endpoint — copy `.env.example` to
`.env.local` and fill these in with a free [finnhub.io](https://finnhub.io) API key.
`NEXT_PUBLIC_MARKET_DATA_PROVIDER` is currently a display label only (e.g. `Finnhub`), not a
multi-vendor selector — see [`ExternalMarketDataProvider`](src/lib/market-data/external-market-data-provider.ts)
to add another vendor.

**If the external provider is configured but fails**, the app does not break:
`ResilientMarketDataProvider` catches the failure, logs it to the console, falls back to mock
prices for the rest of the session (no repeated retries), and System Health's Market Data panel
shows mode "Fallback" with the failure reason. The Dashboard's Market Data Status card always
reflects the real, current state: provider, mode, last updated, instruments loaded, and whether
fallback is active.

Only prices for *existing* positions and the Watchlist go through this provider in this build —
new trade entry prices (placed from Signals or Market Intelligence) still use the static mock
instrument price; see [`BUILD-1.0.0.md`](../../docs/product/BUILD-1.0.0.md) for why.

## What's new in 1.1.0

Email/password Supabase Auth, gating the whole app when Supabase is configured — local prototype
mode is unaffected. Paper trades are now user-scoped: a new `user_id` column on `paper_trades`
plus real Row Level Security policies (`auth.uid() = user_id`) replace the permissive placeholders
from Build 0.7.0. `SupabasePaperTradeStore` requires a session for every operation and stamps
`user_id` on insert; `ResilientPaperTradeStore` recognizes "not authenticated" as distinct from
"Supabase unreachable" and does not fall back to local storage for it. System Health gained a live
Authentication panel. No broker execution, no live order placement, no AI. See
[`../../docs/product/BUILD-1.1.0.md`](../../docs/product/BUILD-1.1.0.md) for full details,
including the manual migration steps required and what could not be live-tested in that
environment.

## What's new in 1.0.0

A `MarketDataProvider` abstraction — mock by default, a real Finnhub-backed external adapter when
configured, with the same resilient-fallback pattern Build 0.9.0 introduced for persistence.
Watchlist now shows live-style current price, change, last-updated time, and data source; Paper
Portfolio and the Dashboard's paper trading summary value open trades through the provider instead
of a hardcoded mock function; System Health and the Dashboard both gained a Market Data status
view. No broker execution, no live order placement, no AI. See
[`../../docs/product/BUILD-1.0.0.md`](../../docs/product/BUILD-1.0.0.md) for full details.

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

- Password reset, magic links, OAuth providers — email/password sign-up/sign-in only
- Roles, teams, or shared/admin access — a paper trade belongs to exactly the user who created it
- Server-side session verification (middleware, protected API routes) — gating is client-side only
  (`AuthGate`), appropriate for this prototype's architecture but not a production substitute
- Real broker connections, live order placement, or any real execution
- Real-time sync or multi-tab updates from Supabase (data loads once per page load, not polled)
- Automatic reconnection within a session after falling back to local storage or mock prices
  (reload the page to try the real provider again)
- A deployed/linked Supabase project or CI for running migrations
- Partial trade closes, position netting, or live/scheduled price movement
- Multiple external market data vendors (only one Finnhub-shaped adapter exists so far); historical
  prices, charts, or intraday movement
- Live pricing for new trade entries (Signals/Market Intelligence still use the static mock
  instrument price at the moment a trade is placed)
- Technical indicators or model-generated scoring behind Market Intelligence or the Intelligence
  Score
- Persistence of Intelligence Scores at the time a trade was opened (scores are computed from
  mock data on every render, not stored on the trade)
- Per-user scoping of the first-run import prompt (it's a single browser-wide flag)
- AI-generated signals or agents
- Financial advice of any kind

See [`../../docs/product/BUILD-0.1.0.md`](../../docs/product/BUILD-0.1.0.md),
[`../../docs/product/BUILD-0.1.1.md`](../../docs/product/BUILD-0.1.1.md),
[`../../docs/product/BUILD-0.2.0.md`](../../docs/product/BUILD-0.2.0.md),
[`../../docs/product/BUILD-0.3.0.md`](../../docs/product/BUILD-0.3.0.md),
[`../../docs/product/BUILD-0.4.0.md`](../../docs/product/BUILD-0.4.0.md),
[`../../docs/product/BUILD-0.5.0.md`](../../docs/product/BUILD-0.5.0.md),
[`../../docs/product/BUILD-0.6.0.md`](../../docs/product/BUILD-0.6.0.md),
[`../../docs/product/BUILD-0.7.0.md`](../../docs/product/BUILD-0.7.0.md),
[`../../docs/product/BUILD-0.8.0.md`](../../docs/product/BUILD-0.8.0.md),
[`../../docs/product/BUILD-0.9.0.md`](../../docs/product/BUILD-0.9.0.md),
[`../../docs/product/BUILD-1.0.0.md`](../../docs/product/BUILD-1.0.0.md), and
[`../../docs/product/BUILD-1.1.0.md`](../../docs/product/BUILD-1.1.0.md) for the full build
records; [`../../docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md)
and [`../../docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md) for the
schema and setup guide; and
[`../../sprints/sprint-001/SPRINT-001.md`](../../sprints/sprint-001/SPRINT-001.md) for sprint notes
and the next recommended build.
