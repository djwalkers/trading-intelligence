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
[`docs/product/BUILD-0.9.0.md`](../../docs/product/BUILD-0.9.0.md),
[`docs/product/BUILD-1.0.0.md`](../../docs/product/BUILD-1.0.0.md),
[`docs/product/BUILD-1.1.0.md`](../../docs/product/BUILD-1.1.0.md),
[`docs/product/BUILD-1.2.0.md`](../../docs/product/BUILD-1.2.0.md),
[`docs/product/BUILD-1.3.0.md`](../../docs/product/BUILD-1.3.0.md),
[`docs/product/MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md`](../../docs/product/MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md),
[`docs/product/MISSION-1.1-BOT-CANDIDATE-FALLBACK.md`](../../docs/product/MISSION-1.1-BOT-CANDIDATE-FALLBACK.md),
[`docs/product/MISSION-2-PORTFOLIO-RISK-MANAGER.md`](../../docs/product/MISSION-2-PORTFOLIO-RISK-MANAGER.md),
[`docs/product/MISSION-3-POSITION-MANAGER.md`](../../docs/product/MISSION-3-POSITION-MANAGER.md),
[`docs/product/MISSION-4-SCHEDULED-BOT-SCANS.md`](../../docs/product/MISSION-4-SCHEDULED-BOT-SCANS.md),
[`docs/product/MISSION-5-VERIFICATION-READINESS.md`](../../docs/product/MISSION-5-VERIFICATION-READINESS.md),
[`docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md`](../../docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md),
[`docs/product/MISSION-7-DECISION-INTELLIGENCE.md`](../../docs/product/MISSION-7-DECISION-INTELLIGENCE.md),
[`docs/product/MISSION-8-VPS-WORKER.md`](../../docs/product/MISSION-8-VPS-WORKER.md),
[`docs/product/MISSION-9-HISTORICAL-MARKET-DATA.md`](../../docs/product/MISSION-9-HISTORICAL-MARKET-DATA.md),
[`docs/product/MISSION-10-SERVER-SCHEDULE-ACTIVATION.md`](../../docs/product/MISSION-10-SERVER-SCHEDULE-ACTIVATION.md),
[`docs/product/MISSION-11-OUTCOME-ANALYSIS.md`](../../docs/product/MISSION-11-OUTCOME-ANALYSIS.md),
[`docs/product/MAINTENANCE-1.11.2-REAL-MARKET-DATA.md`](../../docs/product/MAINTENANCE-1.11.2-REAL-MARKET-DATA.md),
[`docs/product/BUILD-1.12.0.md`](../../docs/product/BUILD-1.12.0.md),
[`docs/product/BUILD-1.12.1.md`](../../docs/product/BUILD-1.12.1.md),
[`docs/product/BUILD-1.12.2.md`](../../docs/product/BUILD-1.12.2.md),
[`docs/product/BUILD-1.13.0.md`](../../docs/product/BUILD-1.13.0.md),
[`docs/database/SUPABASE-PERSISTENCE-PLAN.md`](../../docs/database/SUPABASE-PERSISTENCE-PLAN.md),
[`docs/database/SUPABASE-SETUP.md`](../../docs/database/SUPABASE-SETUP.md),
[`docs/operations/DEPLOYMENT.md`](../../docs/operations/DEPLOYMENT.md),
[`docs/operations/RUNBOOK.md`](../../docs/operations/RUNBOOK.md),
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

**Build 0.9.0 (real Supabase persistence)**

- `SupabasePaperTradeStore` is now a real implementation against the Build 0.7.0 schema using
  `@supabase/supabase-js` — no database redesign; `paper_trades`, `trade_intelligence`, and
  `trade_events` are used exactly as created
- `getPaperTradeStore()` genuinely selects Supabase when both environment variables are set,
  local storage otherwise — no UI changes required either way
- New `ResilientPaperTradeStore`: if Supabase ever fails, it logs the reason, falls back to local
  storage for the rest of the session (no repeated retries), and retries the failed operation
  locally so the user's action still succeeds; a small app-wide banner appears only when this has
  happened
- First-run import: when Supabase is active, empty, there's existing local history, and the
  prompt hasn't been answered before, a one-time modal offers to import it — never shown again
  after either Import or Skip
- System Health's persistence rows are now live, not mocked: Current mode, Connection
  (Connected/Disconnected, with reason), and Last Synchronisation
- `PaperTradeStore` interface redesigned from a generic `save(allTrades)` to granular
  `addTrade`/`closeTrade`, since Supabase needs to know precisely which row to insert vs. update
  and when to append a `trade_events` row; `PaperTradesContext.updateTrade` renamed to
  `closeTrade` to match (it was already only ever called for closing)
- Only the public anon key is used, client-side, relying entirely on the existing RLS policies —
  no service role key anywhere in the app
- Verified: existing `localStorage` behaviour unchanged and fully regression-tested; failure
  handling verified against a deliberately unreachable Supabase URL (no crash, correct banner,
  correct System Health status, continued local operation). **Not verified against a real,
  reachable Supabase project** — no live project was available to test against in this
  environment

**Build 1.0.0 (market data layer)**

- New `MarketDataProvider` abstraction (`src/lib/market-data/`): `MockMarketDataProvider` (wraps
  the existing mock instruments + the price drift table, promoted here from
  `lib/utils/paper-trade.ts`) and a real `ExternalMarketDataProvider` calling Finnhub's quote
  endpoint — mock remains the default and the fallback; the app requires no configuration
- `ResilientMarketDataProvider` mirrors Build 0.9.0's `ResilientPaperTradeStore` exactly: external
  is tried first when configured, falls back to mock and stays there for the session if it ever
  fails, and tracks a live `MarketDataStatus` consumed via `useMarketDataStatus()`
- Two new optional environment variables, `NEXT_PUBLIC_MARKET_DATA_PROVIDER` and
  `NEXT_PUBLIC_MARKET_DATA_API_KEY` — neither required to run the app
- Watchlist (`WatchlistView`) now shows current price, daily change (value + percent), a
  last-updated timestamp, and a Mock/External source badge, sourced live via `useMarketQuotes`
- Paper Portfolio and the Dashboard's paper trading summary now value open trades through the
  provider instead of a hardcoded mock function; `PaperTradesTable` gained a "Current price" column
- Dashboard gained a "Market Data Status" card; System Health gained a live Market Data panel,
  replacing the static, stale "Market Data: Mocked" row that had been unchanged since Build 0.1.0
- `getCurrentMockPrice` removed from `lib/utils/paper-trade.ts`; `calculatePaperTradePerformance`
  and `buildClosedTrade` now take prices as parameters instead of sourcing them internally, so
  every price in the app flows through the same provider seam
- Recreated `.env.example`, which had been accidentally deleted in the commit that validated
  Supabase persistence, with corrected wording plus the two new market data variables
- No broker execution, no live order placement, no AI — exactly as instructed
- Verified: app runs correctly with no market data environment variables; a fake external
  provider/key pair fails gracefully (logged, System Health shows "Fallback" with reason, Dashboard
  shows fallback active); paper trading, Trade Journal, and Supabase persistence all continue to
  work unaffected. **Not live-tested against a real Finnhub API key** — none was available in this
  environment.

**Build 1.1.0 (Supabase Authentication & user-scoped paper trading)**

- Email/password Supabase Auth (`src/lib/auth/auth-context.tsx`): sign up, sign in, sign out, via
  a new shared client (`src/lib/supabase/client.ts`) used by both auth and persistence
- New `AuthGate` gates every page behind sign-in when Supabase is configured; local prototype mode
  (no env vars) is completely unaffected — no gating, no sign-in, exactly as before
- New `/sign-in` and `/sign-up` pages matching the existing dark theme, rendered in a minimal
  centered layout (no sidebar); sign-out available from the sidebar next to the user's email
- New migrations: `0006_add_user_id_to_paper_trades.sql` (nullable `user_id uuid references
  auth.users`) and `0007_user_scoped_row_level_security.sql` (drops the Build 0.7.0 permissive
  placeholder policies, replaces them with `auth.uid() = user_id` scoping on `paper_trades`, and
  join-based scoping on `trade_intelligence`/`trade_events`, which have no `user_id` of their own)
- `SupabasePaperTradeStore` now requires a live session for every operation, stamps `user_id` on
  insert, and explicitly filters by it; throws a distinct `AuthRequiredError` when there's no
  session, which `ResilientPaperTradeStore` recognises and does **not** fall back to local storage
  for (that would silently start saving to an unscoped store — wrong for a user-scoped app)
- `AuthContext` tracks session-expiry (signed-in → signed-out without a deliberate sign-out) and
  shows "Your session has expired. Please sign in again." on the sign-in page
- `PaperTradesProvider`'s hydration effect now re-keys on the effective auth identity (local /
  unauthenticated / a specific user id) instead of running once on mount — necessary so a user who
  signs in after the initial page load actually gets their trades loaded
- System Health gained a live Authentication panel: Auth (Enabled/Disabled), Current user, Data
  scope (User scoped / Local prototype)
- No broker execution, no live order placement, no AI, no "Hermes" — exactly as instructed
- Verified: local prototype mode fully regression-tested (unaffected by any of the above); with
  Supabase configured, unauthenticated access to any route correctly redirects to `/sign-in`;
  sign-up against the real connected project succeeds; sign-in against an unconfirmed account
  correctly surfaces "Email not confirmed" from Supabase itself. **Not verified**: the two new
  migrations were not applied to the live project (requires SQL Editor / service-role access this
  app is never given), so the authenticated write path, RLS scoping, and Trade-Journal-per-user
  filtering were not live-tested; the project's Supabase Auth also requires email confirmation and
  no inbox was available, so the full sign-up → confirm → sign-in happy path wasn't completed
  either. Both limitations were raised with, and accepted by, the user before proceeding.

**Build 1.2.0 (password reset & provider-backed trade entry pricing)**

- "Forgot password?" on sign-in links to new `/forgot-password` (email → `resetPasswordForEmail`,
  generic "check your inbox" message regardless of whether the address is registered) and
  `/reset-password` (relies on Supabase establishing a temporary recovery session from the emailed
  link; shows "invalid or expired" instead of a broken form if there's no session) — both in the
  same minimal centered auth layout as sign-in/sign-up
- Trade entry prices now come from `MarketDataProvider`, closing the gap Build 1.0.0 left: placing
  a trade from Signals or Market Intelligence fetches a live quote at that moment, the same way
  closing a trade already did. New shared `usePaperTradeEntryFlow` hook (generic over Signal or
  Opportunity) owns the fetch; `buildPaperTradeFromSignal`/`buildPaperTradeFromOpportunity` now
  take the resolved `EntryPriceInfo` as a parameter instead of sourcing a static mock price
  themselves
- `PaperTradeModal` shows the price source (Mock/External + provider), a last-updated timestamp,
  and an amber note if the quote came from a mock fallback; Confirm is disabled until the price
  resolves, with "Fetching current price…"/"Calculating…" shown while it's in flight
- `PaperTrade` gains three optional fields — `entryPriceSource`, `entryPriceProvider`,
  `entryPriceTimestamp` — recording this provenance; new migration
  `0008_add_entry_price_provenance.sql` adds the matching nullable columns to `paper_trades`
- A live check during this build's testing (an unauthenticated insert genuinely rejected with a
  row-level-security violation) confirmed Build 1.1.0's `0006`/`0007` migrations had since been
  applied to the connected project, outside this session
- No broker execution, no live order placement, no AI, no "Hermes" — exactly as instructed
- Verified: `/forgot-password` renders and submits successfully against the real connected
  project; `/reset-password` correctly detects it has no valid recovery session when visited
  directly; in local prototype mode, both Signal and Market Intelligence trades fetch a live entry
  quote, show it correctly in the modal, and persist all three new fields; closing a trade still
  works; a manually-injected pre-1.2.0 trade (missing all three new fields) still loads and values
  correctly with no console errors, directly confirming backward compatibility. **Not verified**:
  migration `0008` has not been applied to the live project yet, and the project's Supabase Auth
  still requires email confirmation with no inbox available, so an authenticated trade actually
  persisting to Supabase with both `user_id` and entry-price provenance together was not exercised
  end-to-end.

**Build 1.3.0 (Strategy Engine)**

- New `StrategyEngine` (`src/lib/strategy-engine/`): three independent, deterministic strategies —
  Moving Average Crossover, RSI Reversal, Momentum — each a pure function of a shared
  `StrategyContext` derived from an instrument's existing mock snapshot (no historical price
  series exists in this prototype, so moving averages/RSI/volume ratio are all deterministic
  proxies, not random or live data)
- The engine aggregates the three results per instrument into a `StrategyScore`: overall signal,
  overall confidence, an overall recommendation (mapped onto the existing 5-level `Recommendation`
  type from Build 0.3.0), and an agreement level — Strong Agreement (unanimous) → Moderate
  Agreement (majority + neutral dissent) → Mixed Signals (majority + opposite-direction dissent) →
  Conflict (three-way split, no majority)
- Market Intelligence's recommendation/confidence/narrative/evidence are now computed from the
  engine instead of static mock text (`applyStrategyEngineToOpportunity`); three new sections —
  Generated By (compact per-strategy vote list + overall summary), Strategy Breakdown (full
  evidence + each strategy's percentage contribution), and Agreement (level + explanation). The
  existing Decision Breakdown and Intelligence Score sections are untouched — separate,
  pre-existing systems from Builds 0.3.0/0.8.0
- Watchlist and the Dashboard's watchlist snapshot gained a Primary Strategy column (the
  highest-confidence individual strategy per instrument, even when it dissents from the overall
  call — TSLA and NVDA both show their dissenting strategy as primary, which is intentional)
- Dashboard gained a Strategy Summary card (strategies evaluated, average confidence, agreement
  distribution, highest confidence strategy); System Health gained a live Strategy Engine panel
  (Running, strategies loaded, evaluation time measured in real, sub-millisecond numbers) —
  replacing the now-redundant static "Strategy Engine: Running" row that had been in the Services
  list unchanged since Build 0.1.0
- `PaperTrade` gains four new optional fields (`primaryStrategy`, `strategyAgreement`,
  `overallConfidence`, `evidenceSummary`), populated only for Market-Intelligence-sourced trades;
  new migration `0009_strategy_engine.sql` adds the matching nullable columns
- The engine's `Strategy` interface deliberately isn't exported from the shared `@/lib/types`
  barrel — that barrel already has an unrelated `Strategy` type (the Strategies page's mock rule
  metadata, Build 0.1.0); same word, two different concepts, kept apart in
  `src/lib/strategy-engine/strategy.ts` rather than overloading one name
- No AI, no live data, no broker integration, no autonomous trading — every recommendation is
  reproducible: the same instrument snapshot always produces the same strategy results
- Verified in local prototype mode: Generated By/Strategy Breakdown/Agreement render correctly and
  match hand-calculated values exactly for every instrument; placing and closing a Market
  Intelligence trade persists and displays all four new fields correctly; Watchlist/Dashboard
  Primary Strategy columns match hand-calculated values; the old Strategies/Signals pages are
  completely unaffected; gating with Supabase configured has no regressions. **Not verified**:
  migration `0009` has not been applied to the live project, and (per the limitation disclosed in
  Builds 1.1.0/1.2.0) no confirmable test account was available, so a Market-Intelligence trade's
  strategy metadata persisting to Supabase end-to-end was not exercised.

**Mission 1 (First Autonomous Paper Trade)**

- New Bot Runner (`src/lib/bot/bot-runner.ts`): a manually-triggered, deterministic loop that scans
  every watchlist instrument through the Strategy Engine (Build 1.3.0, reused unchanged), ranks the
  tradeable opportunities by confidence, and takes the single highest-ranked one
- Five hardcoded risk rules checked against that candidate, always shown whether they pass or fail:
  max one trade per scan (structural), minimum 75% confidence, no trading on Conflict agreement, no
  duplicate open trade for the same instrument + side, and a hard £250 max notional per trade
  (floor-based sizing, deliberately stricter than the existing ~£250 *target* sizing used
  elsewhere, so the cap is a genuine ceiling)
- New Dashboard "Run Bot Scan" button and result panel showing what was scanned, what was selected,
  whether a trade opened, why, and every risk check's outcome
- New Bot Decisions page (`/bot-decisions`) logging every scan, most recent first — deliberately a
  simple `localStorage`-backed React context, not a second persistence abstraction, per the
  mission's explicit "do not overbuild" instruction
- `PaperTrade` gains a `"Bot"` source plus two new optional fields (`sourceBotDecisionId`,
  `riskChecksSummary`); Bot-sourced trades also populate the same Strategy Engine metadata fields
  Market Intelligence trades already use; new migration `0010_bot_runner.sql` adds the matching
  nullable columns and widens the source check constraint
- System Health gained a live Bot Runner panel (Manual Mode, last scan time, last action)
- Fixed a genuine coupling bug from Build 1.3.0: Trade Journal's Strategy Engine metadata block was
  nested inside the Market-Intelligence-only `trade.intelligence` conditional, so it never rendered
  for any other trade source — decoupled so it now renders for both Market Intelligence and Bot
  trades
- No live trading, no broker API, no AI, no "Hermes" — exactly as instructed; the bot only ever
  runs when a human clicks the button
- Verified in local prototype mode: a full scan-to-trade cycle matched hand-calculated expectations
  exactly (NVDA selected, all 5 checks passed, correct £250-capped position size); running a second
  scan correctly triggered the duplicate-trade risk rule ("No Trade", only that check failing); the
  Bot Decisions page and System Health's Bot Runner panel both correctly reflected both scans;
  existing Signal-sourced and Market-Intelligence-sourced trades were placed and verified in the
  same session with no regressions; Supabase-configured gating still works with no regressions.
  **Not verified**: migration `0010` has not been applied to the live project, and (per the
  limitation disclosed in Builds 1.1.0 through 1.3.0) no confirmable test account was available, so
  a Bot-sourced trade's metadata persisting to Supabase end-to-end was not exercised.

**Mission 1.1 (Bot Candidate Fallback and Scan Trace)**

- The Bot Runner no longer stops at the first candidate that fails a risk check: `runBotScan` now
  walks the full ranked candidate list, evaluating risk checks for each in turn, until one passes
  and opens a trade or every candidate has been rejected — still opening at most one trade per
  scan (the loop breaks the instant one passes) and never weakening any of the five existing risk
  rules
- Every scan gets a readable, sequential scan ID (`SCAN-000001`, …) via a small `localStorage`
  counter (`src/lib/bot/scan-id.ts`), deliberately kept separate from the decision log's React
  state since it's read/written synchronously at call time, not during render
- Each `BotDecision` now records a full step-by-step trace (scan started → instruments scanned →
  candidates ranked → each candidate evaluated/rejected → trade opened or not → scan completed)
  plus a per-candidate evaluation list (rank, confidence, agreement, full risk checks, outcome,
  rejection reason); the old flat `riskChecks` field is replaced by per-candidate risk checks, so
  the decision log's `localStorage` key was bumped from `v1` to `v2` rather than migrating old
  entries (a local-browser-only prototype log, not data worth writing migration code for)
- Bot-sourced trades now also store `scanId`; new migration `0011_bot_scan_id.sql` adds the
  matching nullable column
- Dashboard's Bot Runner panel, the Bot Decisions page, and System Health's Bot Runner panel all
  updated to show the scan ID, candidates evaluated/rejected counts, execution time, and (Bot
  Decisions page only) a full per-candidate risk-check breakdown and collapsible scan trace
- No live trading, no broker API, no AI, no "Hermes" — exactly as instructed; none of the five
  risk rules were weakened, removed, or made conditional, only given more candidates a chance to
  clear the same bar
- Verified in local prototype mode with a deliberately constructed three-scan scenario: scan 1
  opened NVDA (no duplicates yet); scan 2 correctly rejected NVDA (now a duplicate) and **fell back
  to TSLA**, which opened; scan 3 correctly rejected both NVDA and TSLA (both now duplicates) and
  opened no trade, reporting "All 2 candidate(s) failed risk checks." At most one trade was opened
  per scan throughout. The Bot Decisions page correctly showed all three scans with full
  candidate-by-candidate detail and an accurate expandable trace; System Health showed the latest
  scan ID and candidate counts; Trade Journal showed the correct `scanId` on the bot trade opened
  via fallback; existing Signal-sourced and Market-Intelligence-sourced trades were placed
  successfully in the same session with no regressions; Supabase-configured gating still works
  with no regressions. **Not verified**: migration `0011` has not been applied to the live project,
  and (per the limitation disclosed in every prior build/mission) no confirmable test account was
  available, so a Bot-sourced trade's `scan_id` persisting to Supabase end-to-end was not
  exercised.

**Mission 2 (Portfolio Risk Manager v1)**

- New Portfolio Risk Manager (`src/lib/bot/portfolio-risk.ts`): `buildExposureSnapshot(trades)`
  computes total open trades, total capital deployed, available cash, and exposure by instrument/
  side/sector; `evaluatePortfolioRisk(...)` checks six hardcoded portfolio-level rules against what
  the portfolio would look like after adding one more candidate trade
- New mock sector/category data (`src/lib/mock/sectors.ts`) for the 5-instrument universe
  (Apple/Microsoft/Nvidia → Technology, Tesla → Consumer Discretionary, S&P 500 ETF → Broad Market
  ETF), kept separate from the `Instrument` type and every UI component
- Six portfolio rules: max 5 open trades, max 60% of starting paper capital deployed, max 30%
  exposure to one sector, max 3 open trades per sector, minimum £1,000 cash remaining after the
  trade, and no more than 4 open trades in the same direction — none of the five existing
  individual risk rules from Mission 1/1.1 were weakened
- Bot Runner now evaluates two tiers per candidate: the five individual checks first (unchanged),
  then — only if those all pass — the six portfolio checks. A candidate that fails either tier
  causes the bot to fall back to the next-ranked candidate, reusing Mission 1.1's fallback loop
  unchanged
- Decision trace gained a "Portfolio snapshot captured" step and a "Portfolio risk evaluated" step
  per candidate that reaches that tier; rejection reasons now distinguish "individual checks
  failed" from "individual checks passed; portfolio risk failed: <which, why>"
- Bot Decisions page gained a collapsible "Portfolio exposure at scan time" section and separate
  "Individual risk checks"/"Portfolio risk checks" lists per candidate; Dashboard panel shows each
  candidate's individual/portfolio status distinctly; System Health gained four new rows (Portfolio
  Risk Manager: Active, Open trade limit, Capital deployment limit, Sector exposure limit)
- `PaperTrade` gains three new optional fields (`portfolioRiskStatus`, `portfolioRiskSummary`,
  `portfolioExposureSnapshot`), populated only for Bot-sourced trades; new migration
  `0012_portfolio_risk_manager.sql` adds the matching nullable columns
- No live trading, no broker API, no AI, no "Hermes" — exactly as instructed
- Verified in local prototype mode using a deliberately seeded portfolio (3 pre-existing open
  Technology trades injected directly into `localStorage`): NVDA (Technology, top-ranked candidate)
  passed all 5 individual checks but correctly failed the portfolio "Max open trades per sector"
  check; the bot correctly fell back to TSLA (Consumer Discretionary), which passed both tiers and
  opened — demonstrating portfolio rejection, fallback, and portfolio-pass-to-open all in one scan.
  A second scan correctly opened no trade at all (NVDA still failed portfolio risk, TSLA now failed
  the individual duplicate check) — confirming the duplicate rule still works and all-candidates-
  fail still correctly opens nothing. The Bot Decisions page showed an exposure snapshot and
  per-check numbers matching hand calculations exactly; System Health showed all four new rows;
  Trade Journal showed `Portfolio risk: Passed` and the six-check summary; existing Signal and
  Market Intelligence trades were placed successfully with no regressions; Supabase-configured
  gating still works with no regressions. **Not verified**: migration `0012` has not been applied
  to the live project, and (per the limitation disclosed in every prior build/mission) no
  confirmable test account was available, so a Bot-sourced trade's portfolio risk metadata
  persisting to Supabase end-to-end was not exercised.

**Mission 3 (Position Manager v1)**

- New Position Manager (`src/lib/bot/position-manager.ts`): `buildPositionContext(symbol, trades)`
  computes existing open trade count, exposure by side, and minutes since the last trade for one
  instrument; `evaluatePosition(...)` classifies a candidate against that context as one of
  `NEW_POSITION` / `ADD_TO_POSITION` / `HOLD_POSITION` / `BLOCK_POSITION`
- The old "no duplicate open trade" individual check is removed entirely — duplicate handling now
  lives in the Position Manager's richer classification. Individual checks drop from five to four
  (max one trade per scan, minimum confidence, agreement not Conflict, max notional)
- ADD_TO_POSITION requires all of: side matches, confidence improved by 5+ points over the latest
  Bot trade in that instrument + side, agreement not weaker, resulting position value ≤ £750, and
  30+ minutes since the last trade there. An opposing existing position or the value cap being
  exceeded is a hard `BLOCK_POSITION`; the comparative/timing conditions not being met is a soft
  `HOLD_POSITION` — both have the same effect (no trade, fall back to the next candidate), but are
  labelled differently since nothing is actually "wrong" in the HOLD case. This split fills a gap
  the mission spec itself didn't resolve (its "Block rules" section listed all six negated
  add-to-position conditions without separately defining what triggers HOLD_POSITION) — documented
  as a disclosed interpretation, not a deviation
- Bot Runner pipeline is now three tiers per candidate: individual risk → Position Manager →
  portfolio risk (Mission 2, unchanged). A portfolio-risk failure after a tentative NEW_POSITION/
  ADD_TO_POSITION overrides the final recorded action to BLOCK_POSITION, satisfying the mission's
  "portfolio risk fails" block condition without duplicating portfolio-risk logic in
  position-manager.ts
- Decision trace gained "Position evaluated" and "Position decision" steps; Bot Decisions page
  gained a "Position Manager" section per candidate; Dashboard panel and Trade Journal both show
  the position action; System Health gained three rows (Position Manager: Active, Max instrument
  position: £750, Add-to-position confidence improvement: +5, Minimum add interval: 30 minutes)
- `PaperTrade` gains four new optional fields (`positionAction`, `existingPositionValue`,
  `positionValueAfterTrade`, `positionDecisionReason`); new migration
  `0013_position_manager.sql` adds the matching nullable columns — columns added before the check
  constraint this time, correctly, unlike migration 0012's original ordering bug (fixed separately)
- No live trading, no broker API, no AI, no "Hermes" — exactly as instructed; none of the four
  individual or six portfolio risk rules were weakened
- Verified in local prototype mode using seeded `localStorage` states (this mock dataset's only two
  tradeable candidates, NVDA and TSLA, never change confidence between scans, so precise scenarios
  require seeding rather than natural repeated scans): a clean scan opened NVDA as `NEW_POSITION`;
  seeding a lower-confidence prior Bot trade on NVDA correctly produced `ADD_TO_POSITION`; seeding
  an insufficient-improvement prior trade correctly produced `HOLD_POSITION` with fallback to TSLA;
  seeding an opposite-side existing position correctly produced `BLOCK_POSITION` with fallback;
  seeding a large existing position correctly triggered the £750 cap as `BLOCK_POSITION` with
  fallback; seeding a too-recent prior trade correctly triggered the 30-minute rule as
  `HOLD_POSITION` with fallback. The Bot Decisions page, System Health, and Trade Journal all
  displayed the position data correctly; existing Signal and Market Intelligence trades were placed
  successfully with no regressions; Supabase-configured gating still works with no regressions.
  **Not verified**: migration `0013` has not been applied to the live project, and (per the
  limitation disclosed in every prior build/mission) no confirmable test account was available, so
  a Bot-sourced trade's position metadata persisting to Supabase end-to-end was not exercised.

**Mission 4 (Scheduled Bot Scans v1)**

- The Bot Runner can now run on a schedule — Manual only (default), Every 15 / 30 / 60 minutes —
  in addition to manual triggering, controlled from new Dashboard controls (mode selector,
  Start/Stop schedule, next/last scan time, Stopped/Running status)
- New `BotSchedulerProvider` (`src/lib/state/bot-scheduler-context.tsx`): shared,
  `localStorage`-persisted schedule state (mode, status, next/last scan, stop reason), readable
  from any page; the actual timer (a 10-second poll checking whether the interval has elapsed)
  lives in the Dashboard's `BotRunnerPanel` and only advances while that component is mounted —
  genuinely browser-based scheduling, explicitly disclosed as not 24/7 (no VPS or background
  worker; see the mission doc for exactly what one would require)
- Every scheduled scan runs through the identical individual/Position Manager/portfolio risk
  pipeline as a manual scan — `runBotScan()` gained a `triggerType` parameter but no separate
  scheduled code path; no risk rule was weakened or bypassed for scheduled runs
- Safety: the schedule stops itself automatically if the user is signed out (checked against
  `useAuth()` before every tick — though the primary protection is structural, since `AuthGate`
  already blocks a signed-out user from reaching the Dashboard/scheduler UI at all when Supabase
  is configured) or if persistence has fallen back away from Supabase (checked against
  `usePersistenceStatus().fallbackReason`)
- `BotDecision` gains `triggerType` ("Manual" | "Scheduled"), shown on the Dashboard panel and Bot
  Decisions page; System Health gained four rows (Scheduler: Manual/Running/Stopped, Current
  interval, Last scheduled scan, Next scheduled scan — the last filtered to scheduled-triggered
  decisions specifically, distinct from the existing generic "Last bot scan" row)
- No database migration this mission — scheduler state stays local-only per the explicit
  instruction not to add server-side scheduling yet
- No live trading, no broker API, no AI, no "Hermes" — exactly as instructed
- Verified in local prototype mode: default state was correctly Manual/Stopped with "Start
  schedule" disabled; selecting "Every 15 minutes" and starting correctly set status to Running
  with a next-scan time 15 minutes ahead; seeding an overdue `nextScanAt` and reloading (to
  simulate elapsed time without waiting 15 real minutes) caused the 10-second poll to fire a
  second scan within seconds, correctly logged as `Scheduled`, which correctly opened a TSLA trade
  after the Position Manager correctly rejected NVDA (`HOLD_POSITION`, an existing position from
  the earlier manual scan) — proving the full risk pipeline is active identically on scheduled
  runs; "Stop schedule" correctly halted the schedule and cleared the next-scan time; System Health
  correctly displayed all four new rows; existing Signal and Market Intelligence trades were placed
  successfully with no regressions; Supabase-configured gating still works with no regressions
  (and structurally confirms a signed-out user cannot reach the scheduler UI at all). One lint
  error was found and fixed during development (mutating a `useRef.current` directly during render
  is flagged by this project's React Compiler-style rules; fixed by moving the assignment into a
  plain effect). **Not verified**: the in-tick auth/persistence auto-stop checks (for a session
  that expires or persistence that fails *while* a schedule is already running) could not be
  exercised against a live, authenticated Supabase session — same disclosed limitation as every
  prior build/mission (no confirmable test account was available).

**Mission 5 (Verification & Infrastructure Readiness)**

- Closed out the verification debt disclosed across every prior build/mission: migrations
  `0008`–`0013` were confirmed applied to the connected Supabase project (the user applied them
  directly outside this session); live column checks against every affected table cross-referenced
  against all thirteen migration files
- RLS verified live using only the anon key: anon-key writes to `paper_trades`, `trade_intelligence`,
  and `trade_events` were all confirmed rejected; a genuine `bot-test@andrewwalkers.com` account was
  created, its confirmation email confirmed by the user, and full sign-in/sign-out/sign-in cycling
  verified against the real project
- End-to-end live write test: a real Bot scan against the authenticated test account opened a real
  paper trade and logged a real decision, confirmed via `preview_network`'s actual HTTP responses
  (`201 Created` on both `paper_trades` and `trade_events`), not just the UI — followed by a
  hard-reload persistence check
- Database integrity checks: orphaned rows structurally impossible (FK cascades), invalid `user_id`
  structurally impossible (and live-confirmed correct), duplicate-open-trade prevention confirmed at
  the application layer (not DB-enforced), missing-required-fields live-confirmed via successful
  inserts
- Two disclosed gaps closed by explicit investigation rather than assumption: "learning records"
  (a mission-doc reference to a feature that was never built in any prior mission — confirmed via
  `grep`, zero matches) and "scheduler/config records" (don't exist by design, `BotSchedulerProvider`
  is local-only)
- No code changes — this was a verification-only mission; no new migration, no new UI, no version
  bump
- **Readiness verdict: Ready** across schema/RLS, application logic, and live authenticated
  verification. VPS/background-worker scheduling explicitly out of scope for this mission. Two
  permanent test trades (NVDA, TSLA) now exist in the test account, since the app has no delete
  capability and no SQL access was available to remove them — disclosed, not a defect.

**Mission 6 (Server Architecture Preparation)**

- Architecture review confirmed `runBotScan()` itself was already server-safe (pure computation, no
  persistence, no browser API) — the browser-bound part was purely the orchestration around it
  (loading trades, persisting the result), extracted into a new shared `executeBotScan()`/
  `BotExecutionContext` wrapper (`src/lib/bot/bot-execution-context.ts`) used by both the browser
  panel and a future worker
- New server-only modules (all `import "server-only"`, deliberately not re-exported from the
  client-safe `@/lib/bot` barrel, so importing them into a client component fails the build rather
  than silently leaking a service-role key into the bundle): a service-role Supabase client
  (`src/lib/supabase/service-role-client.ts`), a server-side paper trade store reusing the browser
  store's exact row mapping (newly exported for this purpose), a server-side decision store, and a
  `createServerExecutionContext()` factory — none called by the running app yet
- Two new, dormant, RLS-protected Supabase tables: `bot_schedules` (one row per user — enabled,
  interval, next/last scan, `locked_at`/`locked_by` for concurrency) and `bot_decisions` (append-only,
  full `BotDecision` as `jsonb`) — migrations `0014`/`0015`, neither read nor written by the browser
- Concurrency protection: a per-user advisory lock via a conditional `UPDATE` on
  `bot_schedules.locked_at`/`locked_by` (`claimScheduleLock`/`releaseScheduleLock`,
  `src/lib/scheduler/server-schedule-store.ts`) — deliberately not a database uniqueness constraint
  on open trades, which would have incorrectly broken Mission 3's `ADD_TO_POSITION` feature
- Documented, not fixed: `reserveScanId()` is a per-browser `localStorage` counter, not globally
  unique across a browser and a future worker acting on the same user — flagged for Mission 7
- The existing browser Bot Runner was refactored to go through the new shared wrapper and manually
  re-verified to behave identically: a manual scan and a seeded-overdue scheduled scan both still
  opened trades and logged full decision traces exactly as before
- No new trading strategies or UI features, no VPS deployed, no worker running — purely
  architecture preparation
- **Readiness verdict: Ready** for a future worker to be built against (shared wrapper, server-only
  persistence, dormant schema, and lock primitive all in place, type-checked, build clean).
  **Not ready, and not a goal of this mission**: no worker deployed, the lock is unexercised against
  real concurrency, and the scan-id uniqueness gap remains open. Existing browser behaviour
  confirmed unaffected.

**Mission 7 (Decision Intelligence Foundation)**

- New `DecisionRecord` domain model (`src/lib/decision-intelligence/types.ts`) — an analytical
  snapshot of one candidate a bot scan evaluated (opportunity, strategy attribution, portfolio
  state at that moment, the decision itself, and an outcome field that is always `"Pending"` this
  mission), distinct from `PaperTrade`, which only ever exists for a trade that actually opened
- `buildDecisionRecords()` derives one `DecisionRecord` per candidate from a completed `BotDecision`
  — accepted **and** rejected candidates alike, including every candidate walked during a
  Mission-1.1-style fallback loop, not just the eventual winner — wired into Mission 6's shared
  `executeBotScan()` orchestration via a new `BotExecutionContext.persistDecisionRecords()` method
- Two small, additive extensions to `BotCandidateEvaluation` (`price?`, `primaryStrategyName`,
  `evidenceSummary`) closed a real gap: nothing previously recorded a rejected candidate's price or
  strategy attribution, since only the one candidate that became a `PaperTrade` ever needed it
- New `decision_history` table (`0016_decision_history.sql`) — unlike Mission 6's dormant
  `bot_schedules`/`bot_decisions`, this one is live and used by the browser today via a new
  `SupabaseDecisionHistoryStore`/`LocalStorageDecisionHistoryStore`/`ResilientDecisionHistoryStore`
  stack mirroring the paper-trade persistence pattern exactly, plus a `DecisionHistoryProvider`
  context with the same auth-identity re-hydration behaviour as `PaperTradesProvider`
- New **Decision Intelligence** page (`/decision-intelligence`) — one simple, filterable table (no
  charts): strategy, agreement, symbol, action, and confidence-band filters, all derived dynamically
  from the records present rather than hardcoded
- System Health gained a Decision Intelligence panel (status, records stored, last recorded)
- Every record carries `version` (`DECISION_RECORD_SCHEMA_VERSION = 1`) for future-proofing; the new
  table's RLS already includes an `update` policy, unused this mission, so a future outcome-analysis
  mission (Win/Loss/Neutral) doesn't need a fresh migration just to gain permission to write it
- No AI, no autonomous learning, no strategy optimisation, no outcome judgement — exactly as
  instructed; this mission records evidence, it does not interpret it
- Verified in local prototype mode: a scan against two already-open Bot positions correctly rejected
  both candidates (`HOLD_POSITION`) and produced 2 `DecisionRecord`s, both `Rejected`, with full
  strategy/confidence/rejection-reason detail — confirming rejected and fallback candidates are
  both recorded, not just the winner; a fresh scan with no open positions opened a new NVDA trade
  and produced exactly 1 `DecisionRecord` with `actionTaken: "Trade Opened"` and a matching
  `createdTradeId`; the Decision Intelligence page rendered correctly with working filters; System
  Health showed the correct records-stored count and last-recorded timestamp; Trade Journal and Bot
  Decisions both continued to show full, correct detail with no regressions; Position Manager and
  Portfolio Risk logic were not touched by this mission and behaved identically throughout.
  **Not verified**: migration `0016` has not been applied to the live project, and (per the
  limitation disclosed in every prior build/mission) no confirmable test account was available in
  this session, so a live authenticated write to `decision_history` was not exercised end-to-end —
  `SupabaseDecisionHistoryStore` follows the exact same pattern already live-verified for
  `SupabasePaperTradeStore` in Mission 5.

**Mission 8 (VPS Background Worker)**

- New standalone worker application (`src/worker/`, run via `npm run worker`) — no UI, no web
  server, no API — that wakes up, checks `bot_schedules` for due schedules, executes overdue scans,
  persists results, and sleeps, entirely independent of any open browser tab
- Reuses Mission 6/7's shared pipeline exactly: `executeBotScan()` +
  `createServerExecutionContext()` — Strategy Engine → Position Manager → Portfolio Risk →
  Decision Intelligence → paper trade → trade events, zero duplicated risk logic
- Implements — actually calls, for the first time — Mission 6's advisory lock
  (`claimScheduleLock`/`releaseScheduleLock`): only one scan per user at a time, a held lock is
  skipped safely with a logged reason, a lock is always released (even on failure, with
  `status: "Error"` recorded), and an abandoned lock recovers automatically after five minutes
- Closed a real gap Mission 6 flagged but didn't fix: the browser's `reserveScanId()`
  (`localStorage`-based) can't run in Node — added a worker-local `reserveWorkerScanId()` instead,
  safe because the advisory lock already guarantees no two processes scan the same user at once
- Simple structured logging (`src/worker/logger.ts`) — one line per lifecycle event (started,
  schedule found, lock acquired/skipped, scan executed, trade opened, decision records stored, lock
  released, finished), plain `console.log`, no framework
- Two real fixes were needed to make `npm run worker` runnable outside Next.js's own bundler, both
  discovered by actually trying to run it: `NODE_OPTIONS=--conditions=react-server` (Mission 6's
  `import "server-only"` files throw in plain Node otherwise — that safety mechanism depends on
  Next's bundler, not Node itself) and `tsx --env-file-if-exists=.env.local` (Next auto-loads
  `.env.local`; a standalone script does not)
- No new trading strategies, no Hermes, no learning logic, no UI redesign, no broker integration, no
  outcome analysis — exactly as instructed; the existing browser Bot Runner is untouched
- Verified: `npm run lint`/`npm run build` clean, and `src/worker/` confirmed unreachable from any
  route's bundle graph; running `npm run worker` with only the anon key configured correctly logged
  a clear "service role key not set" error and exited (proving both fixes above actually work, not
  just compile); a temporary in-memory-fake-Supabase-client harness (written, run, and deleted
  within this session) drove the real worker code end to end and confirmed a second concurrent lock
  claim for the same user is correctly rejected, a full scan opened a real trade and stored a real
  Decision Intelligence record with the lock released and `next_scan_at` correctly advanced, and a
  simulated failure still released the lock with `status: "Error"` recorded; the web app and the
  worker were run simultaneously with no port conflicts or interference; a manual browser scan
  afterward still opened a trade and recorded exactly one Decision Intelligence record, confirming
  no regression to the existing Bot Runner. **Not verified**: live concurrency against a real
  Postgres instance (no service role key or CLI access available in this environment, same standing
  limitation since Mission 5), and migrations `0014`–`0016` remain unapplied to the connected
  project.

**Mission 9 (Historical Market Data & Indicators)**

- New historical market data layer (`src/lib/market-data/historical-market-data-provider.ts` +
  Mock/External/Resilient implementations, file-for-file mirroring the existing live-quote
  architecture) serving 90 days of daily OHLCV candles per instrument, batched the same way
  `getQuotes()` already is
- Deterministic mock candles — a seeded PRNG generates a 90-day random walk per symbol (no
  `Math.random()` anywhere), rescaled so the final close lands exactly on that instrument's current
  mock snapshot price; verified directly to reproduce identically across repeated scans in the same
  session
- Six new pure, reusable indicator functions (`src/lib/indicators/`): SMA, EMA (standard
  seed-then-smooth construction), RSI (Wilder's construction, matching the existing 70/30
  thresholds), momentum %, volume ratio, volatility — each a plain number-series-in,
  number-or-null-out calculation, `noUncheckedIndexedAccess`-safe throughout
- `buildStrategyContextFromHistory()` computes the same `StrategyContext` fields the original
  snapshot-proxy `buildStrategyContext()` always produced (EMA(12)/SMA(30) moving-average pair,
  RSI(14), 20-day volume ratio, new 5-day `momentumPercent` field), falling back per-instrument to
  the unchanged snapshot proxy when there isn't enough history yet (fewer than 31 candles) — never a
  hard failure
- **Zero code changes** to Moving Average Crossover or RSI Reversal — they already read these
  fields from `StrategyContext` and don't know whether the values are real or proxied; Momentum
  strategy changed one line to read the new `momentumPercent` field instead of
  `instrument.changePercent` directly (a no-op in the snapshot-fallback path, a real upgrade when
  history is available)
- Wired into the Bot Runner only — `runBotScan()`'s one Strategy Engine call became
  `await getStrategyEngine().evaluateAllWithHistory(instruments)` instead of the synchronous
  `evaluateAll()` — shared by both the browser and the Mission 8 VPS worker through the one
  `executeBotScan()` call site, so neither duplicates the upgrade. Dashboard/Market
  Intelligence/Watchlist display pages deliberately left on the synchronous snapshot-proxy path — a
  disclosed scoping decision (unifying it would mean restructuring those Server Components' data
  model, not just adding history)
- New System Health "Historical Data" panel (provider, connection mode, instruments loaded, last
  refresh), mirroring the existing Market Data panel exactly, including its client-side-singleton
  behaviour (resets on a full page reload, persists across in-app navigation)
- No new trading strategies, no Hermes, no Trading 212 integration, no live trading — exactly as
  instructed
- Verified: `npm run lint`/`npm run build`/`npx tsc --noEmit` all clean. A real
  `SUPABASE_SERVICE_ROLE_KEY` is now present in this environment's `.env.local` (added since
  Mission 8) — `npm run worker` was run live and connected successfully to the real Supabase
  project through this mission's new `bot-runner.ts` → `evaluateAllWithHistory()` →
  `getHistoricalMarketDataProvider()` import chain, polling cleanly with no schedules due (none
  exist yet) before being stopped. A manual Bot Scan in local prototype mode produced a materially
  different result from every prior mission's testing — MSFT (not the previously-consistent NVDA)
  ranked as the sole tradeable candidate, correctly rejected on the notional cap — direct evidence
  the ranking is now driven by real calculated indicators, not the old proxies; repeating the scan
  produced the identical result, confirming determinism. The new Historical Data status panel
  correctly showed its untouched initial state after a full reload and correctly updated after a
  scan run via in-app navigation. Decision Intelligence, Trade Journal, Bot Decisions, Market
  Intelligence, and Watchlist all re-checked with no console errors and no regressions. **Not
  verified**: the external historical provider against a real Finnhub key (none configured, same
  standing gap as the live-quote provider since Build 1.0.0).

**Mission 10 (Server Schedule Activation)**

- New client-safe (anon key, RLS-scoped) `ClientScheduleStore` (`src/lib/scheduler/`) — the
  browser-facing counterpart to Mission 6's service-role-only `server-schedule-store.ts` — reads
  and writes the signed-in user's own `bot_schedules` row via a single atomic `upsert` keyed on
  `unique(user_id)`, `user_id` always stamped from the live session, never from caller input
- New "Server schedule" Dashboard panel (interval 15/30/60, Enable/Disable, last/next scan, last
  status, last error) and a matching "Server Scheduler" System Health panel, both backed by a new
  `ServerScheduleProvider` context that polls every 45s so worker-driven updates (a real scan
  completing) show up without a manual reload
- Explicit Browser/Server schedule distinction — Dashboard's existing schedule section renamed
  "Scheduled scans" → "Browser schedule," with a disclosure cross-referencing the new "Server
  schedule" panel below it; the two systems share no state
- Zero changes to worker trading logic (`src/worker/` untouched) — the existing Mission 8 worker
  picks up rows created this way automatically, since they use the exact schema it already reads
- Confirmed live, not assumed: migrations `0014`/`0015`/`0016` are applied to the connected
  Supabase project (a real service-role key is now available in this environment, added since
  Mission 8) and RLS is active (anon key with no session returns `[]`, not an error or leaked data)
- **Verified extensively against the real, live Supabase project**: a `bot_schedules` row was
  seeded via the service role key using the exact upsert shape the new UI produces, for the
  confirmed test account (`bot-test@andrewwalkers.com`, Mission 5). An unmodified `npm run worker`
  then executed it **66 times** over several hours — each execution correctly evaluating the real
  Strategy Engine/Position Manager/Portfolio Risk pipeline, correctly rejecting NVDA/TSLA (both
  already have open Bot positions from Mission 5, neither newly qualifying for
  `ADD_TO_POSITION`), writing real rows to `bot_decisions` and `decision_history`, and advancing
  `next_scan_at` by exactly the configured interval every single time. `ClientScheduleStore`'s own
  logic was separately verified via an in-memory fake-client harness (create, read, disable,
  re-enable with a new interval — all six checks passed). The schedule was disabled afterward,
  leaving the history rows as a visible record (no delete capability exists, consistent with
  Mission 5's precedent). Local prototype mode re-checked: manual Bot Scan still works, both new
  panels correctly show an "unavailable"/"requires Supabase" state, and the renamed Browser
  schedule panel renders correctly. **Not verified**: clicking Enable/Disable through the actual
  rendered UI against a real live session (no test account password available this session) —
  judged low-risk since the exact database operation and store logic the UI calls were both
  verified directly.

**Mission 11 (Outcome Analysis v1)**

- New pure module `src/lib/decision-intelligence/outcome-analysis.ts` — one shared
  `NEUTRAL_PNL_THRESHOLD_GBP` (£0.01) constant and `computeOutcomeUpdate()`/
  `findReconcilableOutcomes()`, the single functions every trigger path below calls, so they can
  never disagree: Win (`> £0.01`), Loss (`< -£0.01`), Neutral (everything in between). Rejected
  decisions are never classified under any circumstance
- Automatic classification on trade close: `DecisionHistoryProvider` (already nested inside
  `PaperTradesProvider`) reacts to the trade list changing and reconciles immediately, without any
  change to `closeTrade()` itself; a recoverable persistence failure is logged, never blocks the
  close
- Worker reconciliation: `reconcileAllUsers()` runs once per existing poll cycle (no new permanent
  process) for every user known via `bot_schedules`, calling the identical shared function the
  browser uses
- Decision Intelligence page: new Outcome filter (All/Pending/Win/Loss/Neutral, restricted to
  accepted decisions only), an `OutcomeBadge` that shows Rejected rows as "N/A" (never "Pending"),
  three new columns (Realised P/L, Realised P/L %, holding duration), and a new **Outcome summary**
  panel (accepted/closed/pending counts, aggregate P/L, win rate = Wins ÷ (Wins + Losses) only,
  explicitly labelled as paper-trading evidence, not a profitability claim)
- New migration `0017_decision_outcomes.sql` — five nullable columns plus a partial unique index on
  `created_trade_id` enforcing one-decision-to-one-trade at the database level. **Confirmed not yet
  applied to the live Supabase project** — requires manual application via the SQL Editor, the same
  standing limitation as every migration since Mission 5 (no direct Postgres/SQL access in this
  environment)
- **Verified via an 11-scenario pure-function test suite** (Win/Loss/Neutral classification,
  zero/near-zero boundary, open trades staying Pending, Rejected decisions never classified even
  against a plausible trade, idempotency across repeated reconciliation passes, orphaned/mismatched
  trade ids handled safely) — all 11 passed
- **Verified against the real, live Supabase project**: confirmed migration 0017 is not yet applied
  (`42703` on an explicit column select); discovered that `select=*` against a table missing the new
  columns silently omits them rather than erroring, which exposed and let us fix a real bug (the
  original row-mapping code used strict `=== null` checks that would have produced `NaN` instead of
  `undefined` the moment this code ran against the live, unmigrated table — fixed with loose `==
  null` checks); ran the real worker through a full poll+reconcile cycle with no errors; confirmed
  RLS still blocks anonymous reads and writes; confirmed the Mission 10 test schedule is byte-for-byte
  unchanged. Local prototype mode: server-rendered Decision Intelligence page returns `200` with the
  new Outcome summary panel, Outcome filter, and empty-state message all rendering correctly with no
  server errors. **Not verified**: an interactive browser click-through — neither of this session's
  two browser-automation mechanisms (sandboxed preview tool, Claude-in-Chrome extension) was
  reachable; judged low-risk given the pure-function suite and SSR checks cover the same logic and
  rendering paths. No new Supabase rows were created during this mission's testing

**Build 1.12.0 (Operations Centre & UX Polish)**

- Pure UX, terminology, and information-architecture build — no trading logic, risk rule, strategy
  calculation, or database schema changed
- Dashboard rebuilt around "what is my AI doing right now": Portfolio overview, AI activity, Recent
  AI decisions, Market overview, Quick actions — all scheduler configuration moved off it
- New Settings page (`/settings`) hosts both automatic-scanning systems (this browser + always-on
  server-based), market data provider info, and a broker connection placeholder
- The tick that fires a scheduled browser scan moved from the Dashboard's own panel into a new
  headless `AutomationRunner`, mounted app-wide — automatic scanning now keeps running regardless
  of which page is open, not just the Dashboard (previously undisclosed limitation, now fixed)
- System Health redesigned into an Operations Centre (route unchanged at `/system-health`): a top
  Platform Health % verdict plus seven grouped panels (Market Data, AI Engine, VPS Worker, Database,
  Trading Mode, AI Decision History). The static, always-inaccurate `systemServices` mock list
  (permanently reporting "Database: Not Connected" and "Execution Engine: Disabled" regardless of
  actual configuration) was deleted and replaced with a Trading Mode panel that honestly reports
  paper trading as **Enabled**
- Terminology sweep across every visible page: Persistence → Database, Scheduler → Automatic
  Scanning, Decision Intelligence → AI Decision History, Position Manager → Position Protection,
  "Supabase" → "your database" in user copy, "Prototype mode" → "Paper trading only", Mission
  numbers removed from all user-visible copy (kept only in source comments and `docs/product/`
  history)
- Fixed a real accuracy bug found during the sweep: the Bot Decisions page's disclosure still said
  "there is no scheduled or autonomous triggering in this build," stale since Mission 4 added
  scheduling
- **Verified live**: `npm run lint`/`npm run build`/`npx tsc --noEmit` all clean throughout; local
  prototype mode browser session confirmed no console errors on Dashboard/Settings/Operations
  Centre, a manual scan run from the Dashboard correctly updated AI Activity/Recent AI
  Decisions/Bot Decisions/AI Decision History, and automatic scanning started from Settings was
  confirmed still "Running" with a correct next-scan time after navigating to the Dashboard and the
  Operations Centre — proof the new app-wide automation runner works

**Build 1.12.1 (Production Readiness & UX Refinement)**

- Full audit pass — terminology, consistency, empty/loading states, accessibility, data
  presentation — across every page; no trading logic, risk rule, or schema changed
- **Confirmed and fixed a real data bug**: a displayed current price could sit outside its own
  displayed day range (4 of 5 instruments affected — the mock live-quote drift was applied on top
  of a day-high/day-low authored once as static data). Fixed by widening the displayed range to
  always include the current price; no mock data or calculation changed, purely a display fix in
  `WatchlistTable.tsx`
- Replaced remaining developer wording: "Mock"/"Mocked" → "Sample data" (Watchlist, Settings,
  Operations Centre, trade confirmation modals), "VPS Worker" → "Always-On Scanning", "Coming soon"
  → "Not available yet", raw scan ids (one of which exposed an OS process id) → a uniform
  `Scan #N` via a new `formatScanId()` helper, "prototype"/"mock"/"in this build" phrasing removed
  from the 404 page, page metadata, and the Market Intelligence/Signals/Paper Portfolio info notes
- Fixed a confirmed WCAG AA contrast failure: `text-ink-600` (~2.6:1, below the 4.5:1 minimum for
  normal text) used across 13 files, replaced with the already-dominant `text-ink-500` (~4.6:1) —
  an accessibility fix that also reduced the number of "muted text" shades in circulation
- Clarified two real duplication/confusion points found during the audit: Paper Portfolio's
  illustrative starting "Open positions" table vs. the user's own real "Open trades" (previously
  unexplained, now explicitly labelled as separate); and the Signals/Strategies pages' relationship
  to the AI Engine (different strategy names, easy to conflate — now stated explicitly)
- Rewrote every generic empty state (AI Decision History, Bot Decisions, Trade Journal, Open/Closed
  trades) to explain why it's empty, how to populate it, and what will appear there
- Added `isHydrated` to `PaperTradesProvider`/`DecisionHistoryProvider` and used it on the
  Dashboard's Portfolio Overview and the AI Decision History page, so a database-backed account
  loading over the network shows a genuine loading state instead of a misleading "£0.00 / 0" or
  premature "no scans yet" flash
- **Verified live**: `npm run lint`/`npm run build`/`npx tsc --noEmit` all clean; local prototype
  mode browser session confirmed the day-range fix on all 5 Watchlist instruments via page-text
  extraction, "Sample data"/"Not available yet" rendering correctly across Watchlist/Settings/
  Operations Centre, the clarified Paper Portfolio and Signals copy, and zero console errors on
  every page visited

**Build 1.12.2 (Accessibility, Mobile and Interaction Hardening)**

- A shared `Modal` component (`src/components/ui/Modal.tsx`) replaces three duplicated hand-rolled
  dialog implementations (PaperTradeModal, CloseTradeModal, ImportHistoryModal): focus moves into
  the dialog on open (falling back past a disabled initial control to the first genuinely focusable
  one), Tab/Shift+Tab cycle within it, Escape closes it, background scroll locks, and focus returns
  to the trigger element on close — all confirmed with real keyboard input in a live browser session,
  not just code inspection. A companion `Button` component consolidates the same three modals'
  duplicated hover/focus/disabled styling
- `BotDecisionLogProvider` gained the same `isHydrated` flag Build 1.12.1 added to
  `PaperTradesProvider`/`DecisionHistoryProvider` — closes the last local-storage-backed "could
  flash 0/empty before the deferred read resolves" gap, across all four consumers (two Dashboard
  widgets, the Bot Decisions page, and the Operations Centre's AI Engine panel)
- Every data table (Watchlist, Signals, Positions, Paper Trades, the Market Intelligence comparison
  table, AI Decision History) now has `scope="col"` headers, a screen-reader `<caption>`, and a
  labelled, keyboard-focusable (`tabIndex={0}`) horizontal-scroll region — the existing
  horizontal-scroll pattern was kept and hardened rather than replaced with per-table mobile card
  layouts, since it was already consistent everywhere except the AI Decision History table (18
  columns, missing the `min-w`/`scrollbar-thin` every other table had), which was brought in line
- Navigation accessibility: `aria-current="page"` and a visible focus ring on both the desktop
  sidebar and the mobile pill nav (previously hover-only), plus a 44px-minimum touch target on the
  mobile nav strip
- `aria-live="polite"` status regions for scan start/completion (Dashboard's "Run scan now") and
  automatic-scanning enable/disable (Settings); `role="alert"` on the server-schedule save error; a
  visible "Saving…" indicator added where a control could go disabled with no other visible reason
- Verified no horizontal overflow at 320/375/430/768px on every route tested, confirmed the
  automatic-scanning tick still fires correctly in the background (no regression to Build 1.12.0's
  always-on runner), and confirmed all three `BotDecisionLogProvider` hydration states (existing
  decisions, emptied storage, absent key) render correctly with no premature empty state
- **Verified live**: `npm run lint`/`npm run build`/`npx tsc --noEmit` all clean; live keyboard
  testing of the full modal focus-trap flow and the main navigation's tab order; zero console errors
  or hydration warnings across every route and viewport tested

**Build 1.13.0 (Production Readiness and Operational Hardening)**

- A central, validated environment configuration layer (`src/lib/config/`) replaces scattered
  `process.env` reads: half-set variable pairs (e.g. a Supabase URL with no anon key) now throw a
  clear error at startup instead of silently behaving as fully unconfigured; a malformed
  `WORKER_POLL_INTERVAL_MS` now fails loudly instead of silently becoming `NaN`
- A shared `AppError` normalisation layer + structured logger (`src/lib/errors/`, `src/lib/logger/`),
  applied to every existing meaningful `console.error` call site and to a genuine bug found in the
  process: `useBotScanRunner.runScan()` had no top-level try/catch — a scan failure from the
  scheduled tick (which calls it without awaiting or catching) was an **uncaught promise
  rejection**; every path now resolves and surfaces a toast instead
- Route-segment and root error boundaries (`src/app/error.tsx`, `global-error.tsx` — neither existed
  before this build): a safe message, a reference id (Next's own `error.digest`), a retry action, and
  a Dashboard link, verified live via a deliberately-triggered, immediately-reverted test error —
  confirmed the rest of the app (sidebar, navigation) stayed usable while the failing route was
  isolated
- A lightweight toast notification system (`src/lib/notifications/toast-bus.ts`, a plain external
  store rather than a React Context, since persistence failures need to be reportable from
  non-component modules): trade opened/closed, scan started/completed/failed, automation
  enabled/disabled/save-failed, settings saved, and persistence failure (deduplicated to once per
  session) all covered; `aria-live="polite"` region, `role="alert"` on error toasts, capped at 4
  visible, 6-second auto-dismiss, positioned to never overlap the mobile nav
- A small `HealthStatus` model and a new production-safe `/api/health` endpoint — configuration-
  presence based (no live network calls, safe for frequent polling), honestly reports
  `automation: "unknown"` since this process has no channel to the separate VPS worker, matching
  `VPSWorkerStatusPanel`'s existing disclosure
- A persistence-diagnostics audit across all six localStorage-backed stores found several
  **unguarded `localStorage.setItem` calls** (paper trades, decision history, bot decisions, bot
  scheduler) with no try/catch around the write itself — fixed via two shared helpers
  (`setItemOrThrow` for async store methods with an existing `.catch()` up the chain,
  `setItemSafely` for call sites inside a `setState` updater, where throwing would crash the render)
- A single source of truth for the app version (`src/lib/version.ts`, derived from `package.json`)
  fixed a real bug: the Sidebar and Footer had drifted to a stale "Build 1.12.0" while the rest of
  the app had already moved on
- A new Vitest + Testing Library + axe-core test suite (39 tests, 8 files) — config validation
  (including every half-set-pair case), `AppError` normalisation, the health endpoint's shape and
  safety, `BotDecisionLogProvider` hydration (existing/empty/absent), the modal focus trap with real
  simulated keyboard input, and an automated accessibility scan (zero violations) — chosen over
  Playwright since this sandboxed environment cannot reliably download a real browser binary
- `ecosystem.config.js` (PM2, new) defines both the web process and the worker process;
  `docs/operations/DEPLOYMENT.md` and `docs/operations/RUNBOOK.md` (both new) cover prerequisites,
  environment configuration, build/start/worker commands, the health endpoint, process supervision,
  rollback, and symptom-based troubleshooting for 13 operational scenarios
- **Verified live**: `npm run lint`/`npx tsc --noEmit`/`npm run build`/`npm test` all clean;
  `/api/health` confirmed returning the documented shape live; toast notifications observed firing
  from both the automatic-scanning tick and a manual scan; the error boundary verified live via a
  deliberate, immediately-reverted test error; version string consistent across Sidebar/Footer/health
  endpoint; no horizontal overflow at 375px mobile width; zero console errors across every route
  tested

## What is intentionally not included yet

- No true 24/7 scheduling *from the browser* — the browser's own schedule only advances while the
  Dashboard tab is open. Mission 8 built and verified (as far as this environment allows) a
  runnable, tab-independent worker (`npm run worker`), but it has not been deployed to a real VPS
  or run against a real Postgres instance under a process supervisor
- No live concurrency test against a real Supabase project — the advisory lock's behaviour was
  verified against an in-memory fake client (Mission 8), not real concurrent Postgres UPDATEs
  (Mission 10's verification exercised one worker against real schedules repeatedly, but not two
  concurrent processes racing the same row)
- The Server Schedule panel's UI click-handling was not verified against a real live browser
  session (Mission 10) — no test account password was available; the database write and store
  logic it calls were both verified directly instead
- Dashboard/Market Intelligence/Watchlist strategy displays still read snapshot-proxy indicators,
  not real history — only the Bot Runner uses Mission 9's history-aware evaluation, a disclosed
  scoping decision, not an oversight
- `calculateVolatility` (Mission 9) is implemented but not consumed by any strategy or risk rule yet
- The external historical market data provider (Mission 9, Finnhub's daily candle endpoint) has not
  been live-tested against a real API key — no market data key configured in this environment
- No configurable bot risk rules — four individual, five position-level, and six portfolio-level
  thresholds in `bot-runner.ts`/`position-manager.ts`/`portfolio-risk.ts`
- Bot decision log is local-browser-only, not Supabase-scoped per user; only the resulting trade's
  scan id, portfolio risk metadata, and position metadata are persisted to Supabase, not the full
  candidate trace (Decision Intelligence's `decision_history`, Mission 7, is the exception — it
  records full per-candidate detail, Supabase-scoped)
- Outcome analysis (Mission 11) only classifies accepted decisions whose trade has closed —
  Rejected candidates are never classified; no learning, no strategy optimisation, no Hermes
  recommendation logic reads these outcomes yet
- Migration `0017_decision_outcomes.sql` (Mission 11) confirmed not yet applied to the live Supabase
  project — real Win/Loss/Neutral values can't persist there until it's run via the SQL Editor
- Outcome analysis's interactive browser click-through was not verified this session — neither
  browser-automation tool available to this session was reachable (Mission 11); pure-function tests
  and server-rendered HTML checks were used instead
- Portfolio risk limits are percentages of starting paper capital (fixed), not current portfolio
  value — a deliberate v1 simplification
- No correlation-aware or cross-sector portfolio risk — "sector" is the only grouping considered
- Position Manager confidence/agreement comparisons only look at the latest Bot-sourced trade in an
  instrument + side — a manually-opened (Signal/Market Intelligence) position has no comparable
  baseline for the bot to add to
- AI, machine learning, or live/real market data feeding the Strategy Engine
- A fourth strategy (current agreement-aggregation logic is written for exactly three)
- Strategy Engine metadata on Signal-sourced trades (a separate, older mock system, Build 0.1.0)
- Exit/close price provenance (only entry pricing records source/provider/timestamp so far)
- Per-user or per-account strategy configuration
- Magic links, OAuth providers — email/password sign-up/sign-in (plus password reset) only
- Forcing re-authentication after a password reset (the recovery session is used as-is)
- Roles, teams, shared/admin access — a paper trade belongs to exactly the user who created it
- Server-side session verification (middleware, protected API routes) — gating is client-side only
- Real broker connection, live trading, AI agents, payment features
- Real-time sync or multi-tab updates from Supabase (data loads once per page load)
- Automatic reconnection/retry within a session after falling back to local storage or mock prices
- A deployed/linked Supabase project or CI for migrations
- Partial trade closes, position netting, or live/scheduled price movement
- Multiple external market data vendors (one Finnhub-shaped adapter so far), historical prices, or
  charts
- Technical indicators or model-generated scoring behind Market Intelligence or the Intelligence
  Score
- Persistence of Intelligence Scores at the time a trade was opened (scores are computed from
  live mock data on every render)
- Per-user scoping of the first-run import prompt (single browser-wide flag)
- Financial advice language of any kind
- The Signals/Strategies pages' relationship to the AI Engine is now clearly labelled (Build
  1.12.1), not resolved — whether they should eventually be merged, renamed, or retired is a
  product decision, not a UX one
- `aria-live` announcement coverage now reaches trade-opened/closed and scan-outcome events too
  (Build 1.13.0's toast system), but not per-candidate trade-rejection within a scan — a single scan
  can reject several candidates, and per-candidate toasts would violate "avoid stacking without
  limit," so rejection is folded into one "scan complete, no trade opened" toast instead
- An automated accessibility scan now exists (axe-core, Build 1.13.0) but is component-level
  (jsdom-rendered, not a real browser) and covers five representative components (Bot Decisions,
  Settings' browser automation panel, Paper Portfolio, an open modal, the toast viewport), not every
  route individually and not the `color-contrast` rule (jsdom does no layout/paint) — Build 1.12.2's
  manual, real-browser contrast audit remains the actual contrast coverage
- No real browser E2E test suite (Playwright or similar) exists (Build 1.13.0) — the test suite is
  Vitest + jsdom, chosen because this sandboxed environment cannot reliably download a real browser
  binary; full-page SSR and real CSS layout are not exercised by any automated test
- The health endpoint (Build 1.13.0, `/api/health`) reports configuration presence, not live
  connectivity — it cannot currently tell you whether Supabase is actually reachable right now, only
  whether it's validly configured
- `ecosystem.config.js` (Build 1.13.0) has been written and documented but not run against a real
  VPS — like the worker itself since Mission 8, it remains unexercised in a genuine deployment

## How to run

```bash
cd Trading/platform/web
npm install
npm run dev
```

## Next recommended build

With the interface honestly describing the platform, production-ready at the UX layer, hardened for
keyboard/mobile/screen-reader use, and now operationally hardened with configuration validation,
error boundaries, health monitoring, and structured logging (Builds 1.12.0-1.13.0), the outstanding
items are the genuinely architectural ones that have been disclosed since Missions 6-11: (1) **apply
migration `0017` to the live Supabase project and observe the outcome-analysis loop end-to-end** —
run a real scheduled or manual scan, let a trade close, and confirm a real Win/Loss/Neutral value
lands in `decision_history`, the one proof Mission 11 couldn't complete without the migration being
live. (2) **Live concurrency test against real Postgres** — run two worker processes (or a worker
and a browser-triggered scan) against the same user at the same time to confirm the advisory lock
(Mission 6/8) behaves under genuine concurrent load the way the in-memory simulation predicted;
Mission 10 proved repeated correct single-worker execution but not concurrent contention. (3) **Run
`ecosystem.config.js` against a real VPS** — Build 1.13.0 wrote and documented PM2 process
definitions and a full deployment/runbook pair, but neither has been exercised against a genuine
server; this would be the first real-world validation of the worker's entire deployment story since
Mission 8. (4) **Wire the Market Intelligence/Watchlist display pages to Mission 9's/Maintenance
1.11.2's real historical data path** (only the AI Engine's own scans currently benefit from real
Alpha Vantage-backed indicators — the display pages still read snapshot-proxy indicators over sample
data). Independently: connect a real broker sandbox behind Settings' placeholder now that the UI has
a home for it; a real browser E2E suite (Playwright + axe) to close the gap Build 1.13.0's
jsdom-based tests deliberately left open; a strategy or risk rule that uses Mission 9's
`calculateVolatility` (implemented, unused); a richer mock instrument/sector universe (flagged
repeatedly since Mission 2); a fourth Strategy Engine strategy; or exit-price provenance to mirror
Build 1.2.0's entry-price work.
