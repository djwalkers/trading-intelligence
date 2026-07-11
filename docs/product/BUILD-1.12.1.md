# Build 1.12.1 — Production Readiness & UX Refinement

Date: 2026-07-10
Location: `Trading/platform/web`

## What this build is, and isn't

A full audit pass across every page: terminology, consistency, empty/loading states,
accessibility, and data presentation. **No trading algorithm, risk rule, database schema, or
worker behaviour changed** — the one exception, per this build's own instructions, is a verified
data-presentation bug (see below), which is a display-layer fix, not a change to any calculation
the AI Engine, Portfolio Risk Manager, or Position Protection relies on.

## Summary of UX improvements

- **Dashboard hierarchy preserved and reinforced** — no changes needed; Build 1.12.0's KPI-first
  layout already satisfies "understand the most important information within five seconds," and
  this audit found no regressions to it.
- **Clarified a real duplication/confusion point on the Paper Portfolio page**: "Open positions"
  (a fixed, illustrative starting-holdings table, unrelated to the user's own activity) sits
  directly above "Open trades" (the user's real, live trades) — two different concepts that could
  easily read as contradictory or duplicated. The "Open positions" panel description now says so
  explicitly: *"Illustrative starting holdings, shown for reference — separate from the trades you
  place yourself, tracked below."*
- **Clarified the relationship between the Signals/Strategies pages and the AI Engine**: these are
  a separate, simplified, manually-reviewed feed (Build 0.1.0-era) with different strategy names
  (Momentum Breakout, Mean Reversion, Trend Following, Volatility Filter) from the AI Engine's own
  three strategies (Moving Average Crossover, RSI Reversal, Momentum) — genuinely easy to conflate.
  Both pages' descriptions and info notes now name the AI Engine explicitly and state the
  distinction, rather than leaving a first-time user to guess whether they're the same thing.
- **Loading states added where a real gap existed**: `usePaperTrades()` and `useDecisionHistory()`
  now expose `isHydrated`. The Dashboard's Portfolio Overview (Cash available, Open positions) and
  the AI Decision History page now show a genuine loading state instead of briefly flashing "£0.00
  / 0" or a premature "no scans yet" empty-state prompt while a database-backed account's data is
  still loading over the network.
- **Empty states rewritten to explain, not just report absence** — AI Decision History, Bot
  Decisions, Trade Journal, and both Open/Closed trade tables on the Paper Portfolio page now each
  say why the list is empty, how to populate it (including turning on automatic scanning in
  Settings, not just the manual button), and what will appear there — matching this build's own
  example style exactly.

## Summary of bugs fixed

- **Confirmed and fixed the flagged data-integrity bug: a current price could render outside its
  own displayed day range.** Root cause: `dayHigh`/`dayLow` are authored once as static sample data
  (`src/lib/mock/instruments.ts`), but the displayed price includes an independent mock drift
  applied on top (`MockMarketDataProvider`) — for 4 of the app's 5 instruments, that drift pushed
  the "current" price above the authored `dayHigh` (e.g. AAPL: price $214.70 against a day high of
  $214.10; MSFT $445.91 against $445.20; NVDA $138.65 against $136.40; SPY $558.45 against
  $557.90). Fixed in `WatchlistTable.tsx` by widening the displayed range to
  `[min(dayLow, price), max(dayHigh, price)]` — the invariant now holds by construction, and no
  mock data or calculation was altered. Live-verified: all 5 instruments now show the current price
  within its displayed range.

## List of terminology changes

| Before | After | Where |
|---|---|---|
| "Mock" (badge/source value) | "Sample data" | Watchlist Source column, Settings, Operations Centre, trade price-source badges |
| "Mocked" (connection mode) | "Sample data" | Market Data / Historical Market Data connection badges |
| "VPS Worker" (section title) | "Always-On Scanning" | Operations Centre |
| "the automatic server-based scanning worker" | "always-on server-based scanning" | Settings market data panel |
| "Coming soon" | "Not available yet" | Broker connection badges (Settings, Operations Centre) |
| Raw scan ids (`SCAN-000001`, `WORKER-83691-000042` — the latter exposing an OS process id) | `Scan #1` / `Scan #42` | AI Decision History table, Bot Decisions list, Trade Journal entries |
| "prototype paper trading only" | "paper trading only" | Paper trade / close trade confirmation modals |
| "does not exist in this prototype" | "does not exist" | 404 page |
| "A calm, evidence-driven prototype for..." | "...platform for..." | Page metadata description |
| "generated from mock analytical rules for prototyping purposes" | "generated from a fixed set of analytical rules over sample market data" | Market Intelligence info note |
| "mock strategy logic for demonstration purposes only" | "simplified, manually-reviewed strategy feed over sample market data" | Signals info note |
| "Prices and fills are mocked... no real execution exists in this build" | "...use sample data... doesn't exist yet" | Paper Portfolio info note |

## List of consistency improvements

- **Fixed a real WCAG contrast failure**: `text-ink-600` (≈2.6:1 against the app's dark
  backgrounds — below the 4.5:1 AA minimum for normal-size text) was used for body/caption text in
  13 files. Replaced with `text-ink-500` (≈4.6:1, passing) everywhere, which also reduces the
  number of distinct "muted text" shades in circulation from three to two — a consistency win
  alongside the accessibility fix.
- **Unified how "sample vs. live" data is labelled** across Watchlist, Settings, Operations Centre,
  and trade confirmation modals — previously each surfaced the raw internal `"Mock"`/`"Mocked"`
  string directly; now every one of them goes through the same two small label helpers
  (`dataSourceLabel`/`dataModeLabel` in `src/lib/utils/style.ts`), so the wording can never drift
  out of sync again between pages.
- **Unified scan-id presentation** across three previously-inconsistent renderings (a bare
  browser-style id in AI Decision History, an inline id in Bot Decisions, a labelled id in Trade
  Journal) into one `formatScanId()` helper and one consistent `Scan #N` form everywhere.

## Verification performed

- `npm run lint`, `npm run build`, `npx tsc --noEmit` — all clean, run after every major edit batch
  and again at the end.
- **Live browser verification** (local mode, `.env.local` moved aside): confirmed the day-range fix
  on all 5 Watchlist instruments via page text extraction (prices now fall within their displayed
  ranges); confirmed "Sample data" and "Not available yet" render correctly on Watchlist, Settings,
  and the Operations Centre; confirmed the Operations Centre's "Always-On Scanning" section and
  Platform Health (100%, all systems normal) render correctly; confirmed the Paper Portfolio's
  clarified "Open positions" description and the new Open/Closed-trades empty-state copy; confirmed
  the Signals page's clarified relationship-to-AI-Engine copy; checked browser console for errors
  on every page visited — none found.
- Automatic scanning state (started in a prior session) was observed to persist correctly across
  this session's changes, confirming no regression to Build 1.12.0's scheduling behaviour.

## Remaining recommendations

- **Loading-state coverage is not exhaustive.** `isHydrated` was added to `PaperTradesProvider` and
  `DecisionHistoryProvider` and used in the two highest-visibility spots (Dashboard KPIs, AI
  Decision History). `BotDecisionLogProvider`'s hydration was left as-is (always local-only, a
  single near-instant `localStorage` read, negligible flash risk) — a reasonable, deliberate scope
  boundary, not an oversight, but worth revisiting if that store ever becomes database-backed.
- **No focus-trap inside modals** (`PaperTradeModal`, `CloseTradeModal`, `ImportHistoryModal`) — tab
  order can currently leave the dialog while it's open. Escape-to-close and `aria-modal`/
  `aria-labelledby` are already correctly in place; a full focus trap is a reasonable next
  accessibility increment.
- **The Signals/Strategies vs. AI Engine duplication is now clearly labelled, not resolved.**
  Whether these should eventually be merged, renamed, or retired is a product decision beyond this
  build's UX-only scope — flagging it here rather than making that call unilaterally.
- **Mobile responsiveness was not re-tested end-to-end this build** — every table already scrolls
  horizontally in its own container (an existing, consistent pattern), but a dedicated small-screen
  pass was out of scope for this session.
