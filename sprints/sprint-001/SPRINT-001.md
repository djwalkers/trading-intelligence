# Sprint 001

Date: 2026-07-07
Related: [`docs/product/BUILD-0.1.0.md`](../../docs/product/BUILD-0.1.0.md),
[`docs/product/BUILD-0.1.1.md`](../../docs/product/BUILD-0.1.1.md),
[`docs/product/BUILD-0.2.0.md`](../../docs/product/BUILD-0.2.0.md),
[`docs/product/BUILD-0.3.0.md`](../../docs/product/BUILD-0.3.0.md),
[`docs/product/BUILD-0.4.0.md`](../../docs/product/BUILD-0.4.0.md),
[`docs/product/BUILD-0.5.0.md`](../../docs/product/BUILD-0.5.0.md),
[`docs/product/BUILD-0.6.0.md`](../../docs/product/BUILD-0.6.0.md),
[`docs/product/BUILD-0.7.0.md`](../../docs/product/BUILD-0.7.0.md),
[`docs/product/BUILD-0.8.0.md`](../../docs/product/BUILD-0.8.0.md),
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md),
[`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md),
[`infrastructure/supabase/README.md`](../../infrastructure/supabase/README.md)

## Goal

Ship the first usable product prototype for the trading intelligence platform: a dashboard
demonstrating the core product surface (signals, watchlist, paper portfolio, strategies, system
health) using mock data only.

## What was built

**Build 0.1.0**

- Next.js + TypeScript + Tailwind CSS app in `Trading/platform/web`
- Six pages: Dashboard, Watchlist, Signals, Paper Portfolio, Strategies, System Health
- Mock signal engine (instrument, BUY/SELL/HOLD, confidence %, strategy, reason, timestamp)
- Mock paper portfolio starting at £10,000 with open positions and return metrics
- Mock system health panel reflecting the true state of the stack (nothing is connected yet)

**Build 0.1.1 (refinement)**

- Smaller, balanced sidebar icons and a compact logo/title area using the temporary product name
  "Trading Intelligence"
- Smoother responsive layout across smaller laptop screens (four-column and two-column layouts
  now activate at `lg` instead of `xl`)
- Clear "Build 0.1.1" label on the System Health page
- App-wide "Prototype mode" banner, separate from the existing "Paper Trading" badge
- Tighter table/list row spacing across all data views
- Lightweight footer on every page showing build number and data mode

**Build 0.2.0 (interactive paper trading)**

- "Paper Trade" action on BUY/SELL signals (HOLD signals are explicitly not tradeable)
- Risk warning confirmation modal before any paper trade is recorded
- Paper trades held in local React state and persisted to `localStorage` only — no backend
- Paper Portfolio page gains a "Recent paper trades" section and an adjusted cash balance
- New Trade Journal page listing every paper trade with its source signal's strategy, confidence,
  reason, and status
- "Trade Journal" added to navigation

**Build 0.3.0 (Market Intelligence)**

- New flagship "Market Intelligence" page, added to navigation directly below Dashboard, shifting
  the platform's feel from a dashboard toward an evidence-driven analytical assistant
- Market Overview: market status, overall regime (Bullish/Neutral/Bearish), market confidence,
  volatility, and risk environment
- Ranked Opportunities list (five mock instruments) with a Decision Breakdown (five-factor star
  rating), a Strong Buy → Strong Sell recommendation with plain-language reasoning, a "Why this
  recommendation?" evidence list, and a "What could change?" invalidation list for every call
- Deliberately restrained visual design — colour reserved for the two recommendation extremes,
  monochrome star ratings, no gauges or flashy graphics — so conviction reads through layout and
  evidence rather than colour
- Platform philosophy made explicit in-product: "Understand first. Decide second. Trade last."

**Build 0.4.0 (Market Intelligence meets paper trading)**

- "Paper Trade" action added to the Market Intelligence Recommendation panel, reusing the existing
  risk warning modal and `PaperTradesProvider` — no second trade system was built
- Trades are only tradeable on Strong Buy, Buy, or Strong Sell; Hold and Avoid recommendations
  remain deliberately non-actionable, reinforcing "never encourage impulsive trading"
- `PaperTrade` extended with `source` ("Signal" or "Market Intelligence"), plus an optional
  `intelligence` block (recommendation, evidence, evidence factors, invalidation factors) carried
  from the opportunity onto the resulting trade
- Existing localStorage records from before this build (missing `source`) are automatically
  normalized to "Signal" on load — verified against a hand-seeded legacy record
- Trade Journal now shows a Source badge on every trade, a rich Market Intelligence context block
  (recommendation, evidence, invalidation factors) on trades from that source, and five simple
  filters: All, Signals, Market Intelligence, BUY, SELL
- Paper Portfolio's "Recent paper trades" table gained a Source column
- Fixed a pre-existing bug where the Opportunities list claimed to be "Ranked by confidence" but
  was not actually sorted

**Build 0.5.0 (closing the loop: realised P/L)**

- Every open paper trade — on the Paper Portfolio page and in the Trade Journal — has a "Close
  Trade" action, opening a confirmation modal with entry price, current mock price, and estimated
  realised P/L
- `PaperTrade` gained `exitPrice`, `closedAt`, `realisedPnl`, and `realisedPnlPercent` (all
  optional, populated only on close); old localStorage trades need no migration since none of
  them could already be "Closed" — verified against a hand-seeded pre-0.5.0 record
- Each instrument now has a small, fixed, disclosed mock price drift so closing a trade produces a
  real, non-zero realised P/L, without ever changing the Watchlist or any other price display
- Paper Portfolio gained a "Paper trading performance" panel (open/closed counts,
  realised/unrealised/total P/L) and split "Recent paper trades" into separate Open trades and
  Closed trades sections
- Trade Journal shows exit price, close timestamp, and realised P/L on closed trades, plus two new
  filters — Open and Closed — for seven filters in total
- Dashboard gained a compact portfolio performance summary linking to the full Paper Portfolio view
- Fixed a related bug: Paper Portfolio's cash balance previously included capital from every trade
  regardless of status; it now correctly excludes only-open committed capital and adds back
  realised P/L from closed trades

**Build 0.6.0 (Supabase-ready persistence)**

- New `PaperTradeStore` abstraction (`src/lib/persistence/`) with a `LocalStoragePaperTradeStore`
  (the existing behaviour, extracted as-is) and a `SupabasePaperTradeStore` placeholder that
  throws if ever called; `PaperTradesProvider` now goes through this abstraction instead of
  calling `window.localStorage` directly, with no change in behaviour
- `getPaperTradeStore()` always returns the local storage implementation in this build — Supabase
  environment variable presence is informational only (shown on System Health) and never switches
  persistence, so nobody can accidentally lose trade history by setting credentials early
- System Health gained "Persistence Mode" (Local Browser Storage) and "Supabase" (Not
  Configured / Configured) rows
- `.env.example` documents `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` as
  optional — the app requires no environment variables to run
- New [`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md):
  full schema for `paper_trades`, `trade_intelligence`, and `trade_events`, a field-by-field
  mapping from the existing `PaperTrade` type, RLS notes, and a concrete migration path
- Fixed two stale leftovers on the System Health page: the page description and badge still
  hardcoded "Build 0.1.1", and the services count was a hardcoded string instead of derived from
  the actual list

**Build 0.7.0 (real Supabase schema, still local storage)**

- Five real SQL migration files in `platform/web/supabase/migrations/`: `paper_trades`,
  `trade_intelligence`, `trade_events`, indexes (created_at/status/source/instrument/side), and
  Row Level Security placeholder policies (enabled but permissive — no `user_id` column yet
  since there's no auth), turning Build 0.6.0's markdown plan into runnable schema
- `platform/web/supabase/seed.sql` with sample open/closed/Market-Intelligence trades, for
  manually verifying the schema — not read by the app
- New [`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md): create a
  project, run migrations, add environment variables, verify tables, and an explicit note that
  none of this turns on app persistence
- New [`infrastructure/supabase/README.md`](../../infrastructure/supabase/README.md): the
  infra-level pointer to what exists and what doesn't yet (no deployed link, no CI)
- System Health now explicitly reports "Supabase schema: Prepared" and "Supabase persistence:
  Disabled"
- Zero app behaviour changed — `getPaperTradeStore()` still always returns local storage, no
  `@supabase/supabase-js` dependency was added, and no Supabase network calls are possible

**Build 0.8.0 (Intelligence Score)**

- Every opportunity now has an Overall Intelligence Score (0–100) plus seven factors — Trend,
  Momentum, Volume, Volatility, Market Context, Risk, Reward — all on the same "higher is better"
  scale, combined via a fixed, disclosed weighted average (mock and deterministic, no AI, no live
  data)
- "Explain score" section: a rule-based plain-English summary of why the score is high or low,
  plus which factors increased confidence (≥70) and which reduced it (<50) — templated strings,
  not a model
- Comparison feature: tick up to 3 opportunities in the ranked list to reveal a side-by-side
  comparison table (Instrument, Signal, Overall, Trend, Momentum, Volume, Volatility, Risk,
  Reward, Recommendation)
- Watchlist Health summary panel: Excellent (80+) / Good (65–79) / Weak (50–64) / Avoid-monitor
  (below 50) opportunity counts
- Dashboard Intelligence Summary card: highest-scoring opportunity, average score, Excellent
  count, monitor-only count
- Design stayed restrained: plain monochrome bars (no gauges, no neon, no per-factor colour),
  colour reserved for the two band extremes only, matching the existing recommendation-badge
  pattern
- New reusable components: `IntelligenceScoreDisplay`, `IntelligenceScoreBreakdown`,
  `ScoreExplanation`, `ComparisonTable`, `WatchlistHealthSummary`, `IntelligenceSummaryCard`; new
  `summarizeIntelligenceScores` util shared by both the Watchlist and Dashboard summaries
- Fixed stale "Build 0.7.0" labels (sidebar footer, app footer, System Health) — bumped to
  "Build 0.8.0"

## What is intentionally not included yet

- Authentication, real broker connection, live trading, AI agents, payment features
- A real Supabase connection, client, or queries (the store is a placeholder; no
  `@supabase/supabase-js` dependency has been added yet)
- A deployed/linked Supabase project or CI for migrations
- Partial trade closes, position netting, or live/scheduled price movement
- Real market data, technical indicators, or model-generated scoring behind Market Intelligence or
  the Intelligence Score
- Persistence of Intelligence Scores at the time a trade was opened (scores are computed from
  live mock data on every render)
- Financial advice language of any kind

## How to run

```bash
cd Trading/platform/web
npm install
npm run dev
```

## Next recommended build

**Build 0.9.0**: implement `SupabasePaperTradeStore` for real against the now-live schema — add
`@supabase/supabase-js`, wire up the `paper_trades`/`trade_intelligence`/`trade_events` queries,
add a one-time localStorage import step, and flip `getPaperTradeStore()` to select it when
Supabase is configured. Once real persistence exists, storing each trade's Intelligence Score at
open time becomes a natural follow-up. A live (even if still mocked/delayed) price feed to replace
the fixed per-instrument drift would pair well with either piece of work.
