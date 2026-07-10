# Mission 1 — First Autonomous Paper Trade

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`BUILD-1.3.0.md`](./BUILD-1.3.0.md), [`BUILD-1.2.0.md`](./BUILD-1.2.0.md)

## What was built

The first autonomous paper-trading loop: a manually-triggered **Bot Runner** that scans the
watchlist, runs every instrument through the existing Strategy Engine (Build 1.3.0), applies five
hardcoded risk rules, and opens at most one paper trade per scan. **No live trading. No broker
API. No Hermes. No AI.** Every decision — traded or not — is logged and explained.

- **"Run Bot Scan" button** on the Dashboard. One click runs one scan: it shows how many
  instruments were reviewed, which one (if any) was selected, whether a trade was opened, why, and
  the result of every risk check.
- **Five hardcoded risk rules**, checked in order for the single highest-confidence tradeable
  candidate: max one new trade per scan (structural, not a counter), minimum 75% confidence, no
  trading when agreement is Conflict, no duplicate open trade for the same instrument + side, and a
  hard £250 max notional per trade. All five checks always run and are always shown, whether they
  passed or not — including on a rejected candidate, so the log always explains what would have
  needed to be true.
- **Bot Decisions page** (`/bot-decisions`) — every scan this browser has run, most recent first:
  timestamp, instruments scanned, selected instrument, action taken, reason, every risk check's
  result, and whether a trade was created. Stored in `localStorage` only, deliberately not wired
  into the Supabase persistence layer — a simple, local decision log, not a second data store.
- **Trade metadata** — trades the bot opens carry `source: "Bot"`, plus the same
  `primaryStrategy` / `strategyAgreement` / `overallConfidence` / `evidenceSummary` fields Market
  Intelligence trades already record (Build 1.3.0), a new `riskChecksSummary`, and a
  `sourceBotDecisionId` linking back to the decision log entry that created it. Existing Signal and
  Market Intelligence trades are completely unaffected.
- **System Health** gained a Bot Runner panel: always "Manual Mode" (no scheduler exists), the
  timestamp of the last scan, and the outcome of the last action.
- **Trade Journal** gained a "Bot" filter alongside the existing All / Open / Closed / Signals /
  Market Intelligence / BUY / SELL filters, and now shows the Strategy Engine metadata block for
  *any* trade that has it — previously that block was accidentally nested inside the
  Market-Intelligence-only conditional, a coupling this mission had to undo (see below).

## Architecture overview

```
runBotScan(instruments, openTrades)  — pure async function, the entire bot
  1. getStrategyEngine().evaluateAll(instruments)     — reuse Build 1.3.0 unchanged
  2. filter to signal !== HOLD && isTradeableRecommendation(...)
  3. sort by confidence desc, take the single top candidate
  4. run 5 BotRiskCheck entries against it (one live getQuotes() call for pricing)
  5. if all pass: build a full PaperTrade (source: "Bot") + a "Trade Opened" BotDecision
     if any fail: return a "No Trade" BotDecision explaining which check(s) failed
  → never touches persistence itself — the caller adds the trade and logs the decision
```

`runBotScan` lives in `src/lib/bot/bot-runner.ts` and is deliberately **not** wrapped in a
resilient-fallback layer like `MarketDataProvider` or the persistence stores — it has no
independent failure mode of its own; its one impure dependency (`getMarketDataProvider().getQuotes()`)
is already resilient, and everything else is synchronous, in-memory computation over data the
Strategy Engine already produces deterministically.

**Why `BotDecision`/`BotRiskCheck`/`BotScanResult` aren't in the shared `@/lib/types` barrel:**
same reasoning as Build 1.3.0's `Strategy` type — this is a self-contained Mission 1 feature, not a
core domain concept every page needs. They live in `src/lib/bot/types.ts`, imported by full path.

**Why the decision log is a plain `localStorage`-backed React context, not a `PaperTradeStore`-style
abstraction:** the mission explicitly said "use local state/Supabase persistence only if simple; do
not overbuild." A second storage-agnostic interface, a Supabase table, and matching RLS policies for
a read-mostly, per-browser scan log would have been solving a problem nobody asked for. Only the
resulting `PaperTrade` rows — which already have a home — gained two new nullable columns.

**Sizing uses a different, stricter calculation than the rest of the app.** Every other paper trade
entry point uses `quantityForEntryPrice`, which *rounds* to the nearest share for a ~£250 *target*
and can land slightly over it (e.g. 2 shares of a $137 stock ≈ $274). The bot's "max notional per
trade: £250" is a risk rule, not a target, so it needs a genuine, never-exceeded ceiling:
`quantity = Math.floor(250 / price)`. For instruments priced above £250 (e.g. MSFT, SPY in this
mock data), that floors to 0 shares, and the notional check correctly fails with "no valid position
size" rather than silently rounding up over the cap.

**A pre-existing simplification, not introduced by this mission:** the £250 cap is compared
directly against USD instrument prices with no FX conversion — consistent with how every other GBP
figure in this prototype (`paperPortfolio`, the ~£250 target sizing) already ignores FX. Disclosed,
not fixed, here.

**A genuine architectural fix made along the way:** Build 1.3.0's `TradeJournalEntry` nested the
Strategy Engine metadata block *inside* the `trade.intelligence`-only conditional, so it only ever
rendered for Market-Intelligence trades — accidentally coupling two independent concerns (which
strategy engine metadata exists vs. which trade source has an `intelligence` block). This mission
pulled the metadata block out to its own top-level `trade.primaryStrategy` conditional so it renders
identically for Market Intelligence and Bot trades, while `trade.intelligence`'s recommendation
badge and evidence lists remain exclusively for Market Intelligence.

## Risk rules implemented

| # | Rule | Enforced as |
|---|------|-------------|
| 1 | Max one new paper trade per scan | Structural — only `candidates[0]` is ever considered, no loop over remaining candidates |
| 2 | No duplicate open trade, same instrument + side | Checked against every currently-open trade passed into the scan |
| 3 | Minimum confidence 75% | `selected.overallConfidence >= 75` |
| 4 | Block trades where agreement is Conflict | `selected.agreement !== "Conflict"` |
| 5 | Max notional per trade £250 | Hard floor-based sizing (see above); fails if even 1 share would exceed £250 |

Paper trading only — enforced simply by the fact that the only artifact ever produced is a
`PaperTrade`, the same type every other part of the app already produces; there is no code path to
a broker anywhere in this mission.

## Files changed

New:
- `src/lib/bot/types.ts` — `BotRiskCheck`, `BotDecision`, `BotScanResult` (not barrel-exported)
- `src/lib/bot/bot-runner.ts` — `runBotScan()`
- `src/lib/bot/index.ts` — module barrel
- `src/lib/state/bot-decision-log-context.tsx` — `BotDecisionLogProvider`/`useBotDecisionLog()`
- `src/components/dashboard/BotRunnerPanel.tsx` — Dashboard "Run Bot Scan" button + result panel
- `src/components/bot/BotDecisionsView.tsx` — scan history list
- `src/app/bot-decisions/page.tsx` — Bot Decisions page
- `src/components/system-health/BotRunnerStatusPanel.tsx` — System Health panel
- `supabase/migrations/0010_bot_runner.sql`

Changed:
- `src/lib/types/paper-trade.ts` — `PaperTradeSource` widened to include `"Bot"`; two new optional
  fields, `sourceBotDecisionId` and `riskChecksSummary`
- `src/lib/persistence/supabase-paper-trade-store.ts` — maps the two new columns both ways
- `src/app/layout.tsx` — wraps the app in `BotDecisionLogProvider`
- `src/app/page.tsx` — new "Bot Runner" section wrapping `BotRunnerPanel`
- `src/app/system-health/page.tsx` — new Bot Runner panel; badge bumped to "Build 1.3.0 · Mission 1"
- `src/components/trading/TradeJournalEntry.tsx` — Strategy Engine metadata block decoupled from
  the Market-Intelligence-only conditional; new risk checks summary line
- `src/components/trading/TradeJournalView.tsx` — new "Bot" filter
- `src/lib/utils/style.ts` — `tradeSourceClasses` gains a `"Bot"` case
- `src/components/icons.tsx` — new `BotIcon`
- `src/components/layout/nav-items.ts` — new "Bot Decisions" nav entry
- `src/components/layout/Sidebar.tsx`, `Footer.tsx` — build label bumped to "Build 1.3.0 · Mission 1"

## Database changes

**`0010_bot_runner.sql`** — widens the `paper_trades.source` check constraint to allow `'Bot'`, and
adds two nullable columns: `source_bot_decision_id` (text) and `risk_checks_summary` (text). Both
purely informational, never read by any P/L calculation, so every trade placed before this
migration is unaffected — they simply have both as null. The bot decision log itself has no table;
it is not persisted to Supabase at all, by design (see above).

## Manual Supabase steps required

Run `0010_bot_runner.sql` in the SQL Editor (same anon-key-only limitation as every schema change in
this project — the app is never given DDL or service-role access). Without it, a signed-in
Bot-sourced trade insert fails on the unknown columns and the widened source constraint, which
`ResilientPaperTradeStore` treats as a generic failure and falls back to local storage for the rest
of that session.

Migrations `0008` and `0009` remain unapplied from prior builds, same as reported in
[`BUILD-1.3.0.md`](./BUILD-1.3.0.md); this mission does not change that.

## What is intentionally not included yet

- No scheduled or autonomous triggering — the bot only ever runs when a human clicks "Run Bot
  Scan"; there is no cron, no background job, no polling.
- No live trading, no broker API, no order execution of any kind.
- No AI or machine learning anywhere in the selection or risk logic — five hardcoded, disclosed
  rules, same result every time for the same inputs.
- No configurable risk rules — changing any threshold means editing `bot-runner.ts`, not a settings
  screen (deliberately, per the mission's "simple, hardcoded" instruction).
- The bot decision log is local-browser-only — it does not sync across devices and is not
  Supabase-scoped per user, unlike paper trades themselves. Clearing browser storage clears it.
- No retry or second-candidate fallback within a scan — if the top candidate fails any risk check,
  the scan ends with "No Trade"; it does not try the next-best candidate.
- No FX conversion on the £250 cap (pre-existing simplification, not introduced here).
- No position sizing beyond the flat £250 cap — no portfolio-level exposure limits, no
  diversification rules, no per-instrument caps beyond the single notional check.

## Verification results

**Verified in local prototype mode:**
- Clicking "Run Bot Scan" correctly evaluated all 5 watchlist instruments, selected NVDA (82%
  confidence, Mixed Signals — the highest-ranked tradeable candidate), passed all 5 risk checks
  (confidence, agreement, duplicate, notional at 1 share × $138.65 = $138.65), and opened a real
  BUY paper trade — confirmed against hand-calculated expectations and reflected correctly in the
  Dashboard's paper trading performance summary (open trades: 1).
- Running the scan a **second time** correctly re-selected NVDA as the top candidate again, but this
  time the "No duplicate open trade" check failed (an open BUY position now existed), producing a
  "No Trade" decision — the duplicate-trade risk rule works as specified.
- The Bot Decisions page correctly lists both scans, most recent first, with full risk-check detail
  for each.
- System Health's Bot Runner panel correctly shows "Manual Mode", the timestamp of the most recent
  scan, and the most recent action's outcome.
- Trade Journal correctly displays the Bot-sourced trade with `source: Bot`, primary strategy,
  agreement, overall confidence, and the new risk checks summary line — using the same metadata
  block Market Intelligence trades use, now correctly decoupled from the `intelligence`-only
  conditional.
- Existing Signal-sourced trades (from the Signals page) and Market Intelligence trades were both
  placed and verified end-to-end in the same session with no regressions — all three sources
  (Signal, Market Intelligence, Bot) coexist correctly in Trade Journal and Paper Portfolio.
- `npm run lint` and `npm run build` both pass cleanly; the production build correctly generates
  `/bot-decisions` alongside all other routes.
- Restoring `.env.local` and reloading in Supabase-configured mode still correctly gates behind
  sign-in with no console errors — no regression from this mission's changes.

**Not verified against a real authenticated Supabase session:** migration `0010` has not been
applied to the live project, and (per the limitation disclosed in Builds 1.1.0 through 1.3.0) no
confirmable test account was available in this environment, so a Bot-sourced trade actually
persisting `source_bot_decision_id` and `risk_checks_summary` to Supabase was not exercised
end-to-end.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. `npm run lint` and `npm run build` both pass cleanly.

## What's needed for Mission 2

The verification debt is now four migrations deep (`0008`, `0009`, `0010`, plus confirming a real
test account) — still the top standing priority independent of any new mission. Beyond that,
Mission 2 candidates this mission's design surfaces directly: a second candidate fallback within a
scan (try the next-ranked opportunity if the top one fails a risk check, rather than ending the
scan), portfolio-level exposure limits (a cap across all open bot trades, not just per-trade), or
scheduled/interval-based triggering now that manual triggering is proven — each is a deliberate,
scoped next step rather than a natural extension of this mission's code.
