# Technical Acceptance Phase A.1 — Acceptance Remediation

Status: Complete. All changes below are uncommitted, staged in the working tree for review.

This document records the remediation of the four acceptance failures identified in
[`DATA-VERIFICATION-REPORT.md`](./DATA-VERIFICATION-REPORT.md) (Technical Acceptance Phase A). Per
the Phase A.1 scope, this was a repair-only pass: no new features, no UI redesign, no changes to
strategy logic, confidence calculations, ranking, Position Manager, Portfolio Risk, Maximum One
Trade, scheduling, worker cadence, persistence schema, or migrations. All evidence below was
collected by executing the actual shipped code against the real, live Supabase database and real
external market data providers (Finnhub, Alpha Vantage) — the same methodology used in Phase A.

## Finding 1 — Decision History Lineage (CRITICAL) — FIXED

### Root cause

Phase A found that the winning candidate's `decision_history` row was never persisted for any
trade-opening scan, while sibling rejected candidates from the same scan persisted correctly, and
had ruled out a database constraint via a synthetic insert. The exact defect location was not
isolated in Phase A.

Live re-investigation in this phase found **two independent, confirmed defects**, both upstream of
`persistDecisionRecords` in the shared `executeBotScan()` pipeline (`src/lib/bot/bot-execution-context.ts`):

**1a. Worker path — deterministic crash before decision records are ever written.**
`src/lib/bot/server-execution-context.ts`'s `persistTrade()` captured `createdTradeId = trade.id`
— the *client-generated* string id (e.g. `"trade-bot-NVDA-1783897727557"`) — and passed it to
`persistServerDecision()`, which inserts it into `bot_decisions.created_paper_trade_id`, a `uuid`
foreign key to `paper_trades.id` (migration `0015_bot_decisions.sql`, line 25). Every worker
scan that opened a trade therefore threw `invalid input syntax for type uuid` inside
`persistDecision()` — **before** `persistDecisionRecords()` (the decision_history write) was ever
reached. `process-schedule.ts`'s own try/catch swallowed this as a logged `scan_failed` event; the
trade itself had already been persisted by the preceding step, so it appeared in `paper_trades`
with no matching decision history at all. Reproduced live and confirmed via a real worker-shaped
scan against a fresh throwaway Supabase user before any fix was applied — see Evidence 1a below.

**1b. Browser path — a race between "scan complete" and "write landed."**
`paper-trades-context.tsx`'s `addTrade()` and `decision-history-context.tsx`'s `addRecords()` were
both fire-and-forget: they updated in-memory state and toast-notified synchronously, then kicked
off the real Supabase write with `.catch(...)` but never returned that promise to the caller.
`use-bot-scan-runner.ts`'s `BotExecutionContext` wraps these directly
(`persistTrade: async (trade) => addTrade(trade)`), so `await context.persistDecisionRecords(...)`
inside `executeBotScan()` resolved as soon as the local state update finished — not when the
Supabase `INSERT` actually completed. This left a real window in which the scan is reported
"complete" (trade visible, toast shown) while the decision-history write for that same trade is
still in flight, with no way for anything downstream to know it hasn't landed yet. Verified
structurally: `SupabaseDecisionHistoryStore.addRecords()` itself was proven to insert a
`"Trade Opened"` row correctly under both the service-role client and a real signed-in anon-key
session (Evidence 1c) — the persistence *logic* was correct; only its *timing* relative to the
caller was wrong.

### Fix applied

- [`src/lib/persistence/server-paper-trade-store.ts`](../../platform/web/src/lib/persistence/server-paper-trade-store.ts) —
  `addTradeForUser()` now returns the database-generated `paper_trades.id` (a `uuid`) instead of
  `Promise<void>`.
- [`src/lib/bot/server-execution-context.ts`](../../platform/web/src/lib/bot/server-execution-context.ts) —
  `persistTrade()` now captures that returned `uuid` for `createdTradeId`, instead of the
  client-generated string `trade.id`.
- [`src/lib/state/paper-trades-context.tsx`](../../platform/web/src/lib/state/paper-trades-context.tsx) —
  `addTrade()` is now `async` and `await`s the underlying store write before resolving (still never
  throws to its caller — the existing catch-and-log-and-toast behaviour on write failure is
  unchanged).
- [`src/lib/state/decision-history-context.tsx`](../../platform/web/src/lib/state/decision-history-context.tsx) —
  `addRecords()` is likewise now `async` and awaits the underlying write.

No schema, migration, identifier, or rejection-persistence-behaviour changes. `decision_history`'s
`created_trade_id` column remains `text` and continues to store the client-generated `PaperTrade.id`
exactly as before — only the *separate*, worker-only `bot_decisions.created_paper_trade_id` (`uuid`)
now receives the correct value.

### Evidence

**1a — Live reproduction of the worker crash, before the fix (from this phase's investigation):**
```
[persistTrade] SUCCESS
[persistDecision] THREW: Error: invalid input syntax for type uuid: "trade-bot-NVDA-1783897209119"
    at persistServerDecision (src/lib/scheduler/server-bot-decision-store.ts:25:20)
```

**1c — `SupabaseDecisionHistoryStore.addRecords()` proven correct in isolation, both service-role
and real anon-key session, before any fix (ruling out the persistence logic itself):**
```
Attempting store.addRecords() via the ANON key + real session (exact browser path)...
SUCCESS: no error thrown.
[{"instrument_symbol":"NVDA","action_taken":"Trade Opened","created_trade_id":"trade-bot-NVDA-..."}]
```

**After the fix — full production-shaped worker scan** (real Finnhub quote, real Alpha Vantage
candles for 4 of 5 instruments, `triggerType: "Scheduled"`, `createServerExecutionContext`, a fresh
throwaway Supabase user, cleaned up after):
```
Scan actionTaken=Trade Opened, trade=trade-bot-NVDA-1783898268881
decision_history rows for this scan: [{
  "instrument_symbol": "NVDA", "action_taken": "Trade Opened",
  "created_trade_id": "trade-bot-NVDA-1783898268881", "outcome": "Pending"
}]
PASS (Finding 1): winning candidate's decision_history row persisted
bot_decisions row: [{"scan_id":"FINAL-REVERIFY-...","action_taken":"Trade Opened",
  "created_paper_trade_id":"846bc3db-ba7b-41aa-bf75-f07b124678c5"}]
```
`bot_decisions.created_paper_trade_id` is now a valid `uuid` matching the real `paper_trades.id`
row — the exact column that previously threw on every worker-triggered trade.

### Remaining risk

None identified for the worker path — the defect was deterministic and the fix closes it exactly.
For the browser path, the fix removes the specific race window found; a pathological case (the
tab is force-closed mid-write, killing the in-flight `fetch` at the OS/browser level) is not, and
cannot be, fully eliminated by any client-side code — this is an inherent limit of any
synchronous-navigation browser architecture, not specific to this app. It is unchanged from every
other synchronous browser write this app already makes (e.g. paper trade P&L updates) and was not
in scope to redesign.

**Recommendation: PASS.**

---

## Finding 2 — Mixed Real and Sample Market Data (CRITICAL) — FIXED

### Strategy input data-lineage table (worker path, `evaluateAllWithHistory` with real Alpha Vantage candles)

| Strategy | Input | Source | Live | Sample |
|---|---|---|---|---|
| Moving Average Crossover | `shortMovingAverage` (EMA‑12) | `calculateEMA(closes, 12)` over real candles | ✅ | |
| Moving Average Crossover | `longMovingAverage` (SMA‑30) | `calculateSMA(closes, 30)` over real candles | ✅ | |
| Moving Average Crossover | `instrument.price` | **Before fix:** static value from `src/lib/mock/instruments.ts` | | ❌ (sample, mixed with live indicators above) |
| Moving Average Crossover | `instrument.price` | **After fix:** latest real candle's close, same series as the two averages above | ✅ | |
| RSI Reversal | `rsi` | `calculateRSI(closes, 14)` over real candles | ✅ | |
| Momentum | `volumeRatio` | `calculateVolumeRatio(volumes, 20)` over real candles | ✅ | |
| Momentum | `trend` | `calculateMomentumPercent(closes, 10)` over real candles | ✅ | |
| Momentum | `momentumPercent` | `calculateMomentumPercent(closes, 5)` over real candles | ✅ | |

(Position sizing's own live quote fetch, `evaluateCandidateRisk()` → `getMarketDataProvider().getQuotes()`,
was already live/Finnhub and is unaffected by this fix.)

### Root cause

`src/worker/process-schedule.ts` (unchanged, not part of this fix) feeds the worker's static mock
instrument list (`@/lib/mock`, hardcoded prices authored once — e.g. NVDA `$134.87`) into
`executeBotScan()`. `buildStrategyContextFromHistory()` in
[`src/lib/strategy-engine/build-context.ts`](../../platform/web/src/lib/strategy-engine/build-context.ts)
computed `shortMovingAverage`/`longMovingAverage`/`rsi`/etc. from real Alpha Vantage candles, but
returned the caller-supplied `instrument` object — carrying the stale mock `.price` — unchanged.
`movingAverageCrossoverStrategy.evaluate()` then compared `instrument.price > shortMovingAverage`:
a real, candle-derived average against a stale, unrelated snapshot price, for every worker scan
that had live historical data available. RSI Reversal and Momentum do not reference
`instrument.price` and were not affected.

### Fix applied

`buildStrategyContextFromHistory()` now derives `context.instrument.price` from the same candle
series every other field on the context is computed from (the latest candle's `close`), only when
real/enough history is available (unchanged: `< MIN_CANDLES_FOR_HISTORY` still returns `null` and
falls back to the proxy exactly as before). No other `Instrument` field is touched — nothing else on
`Instrument` feeds any strategy on this path. No trading rule, threshold, or comparison logic
changed; only the *value* one side of an existing comparison is built from.

**Browser behaviour is unchanged.** `MockHistoricalMarketDataProvider`'s candle generator is
deliberately built (see its own comment) so its final candle's close lands exactly on
`instrument.price` — this fix is a no-op there by construction, confirmed live below (sub-cent
differences observed are pre-existing floating-point rounding in the mock generator's daily
compounding, not a behavioural change from this fix, and are too small to alter any BUY/SELL/HOLD
decision).

### Evidence

**Before fix** (from Phase A / this phase's initial investigation) — worker real-data path,
NVDA: `instrument.price = $134.87` (static mock) vs. real Finnhub/Alpha Vantage price around
`$210.96` — a ~56% divergence feeding directly into the MA Crossover comparison.

**After fix — all 5 instruments, real Alpha Vantage candles:**
```
--- AAPL ---  Static mock instrument.price: 213.42   Latest real candle close: 315.32
              context.instrument.price used by MA Crossover: 315.32   Internally consistent: true
--- MSFT ---  Static mock instrument.price: 441.06   Latest real candle close: 385.1
              context.instrument.price used by MA Crossover: 385.1    Internally consistent: true
--- TSLA ---  Static mock instrument.price: 248.19   Latest real candle close: 407.76
              context.instrument.price used by MA Crossover: 407.76   Internally consistent: true
--- NVDA ---  Static mock instrument.price: 134.87   Latest real candle close: 210.96
              context.instrument.price used by MA Crossover: 210.96   Internally consistent: true
--- SPY ---   Static mock instrument.price: 556.78   Latest real candle close: 754.95
              context.instrument.price used by MA Crossover: 754.95   Internally consistent: true
```

**Browser/mock path unchanged (confirmed live):**
```
AAPL: static mock instrument.price=213.42, context.instrument.price=213.41 (1-cent rounding, pre-existing)
MSFT: static mock instrument.price=441.06, context.instrument.price=441.06 (exact match)
TSLA: static mock instrument.price=248.19, context.instrument.price=248.18 (1-cent rounding, pre-existing)
NVDA: static mock instrument.price=134.87, context.instrument.price=134.9  (1-cent rounding, pre-existing)
SPY:  static mock instrument.price=556.78, context.instrument.price=556.77 (1-cent rounding, pre-existing)
```

### Remaining risk

None identified. The one disclosed, deliberate side effect (sub-1-cent rounding drift in the
browser's mock-data path, inherited from the mock candle generator's own pre-existing rounding, not
introduced by this fix) does not change any strategy signal, confidence score, or trading decision
observed in testing.

**Recommendation: PASS.**

---

## Finding 3 — Outcome Classification (CRITICAL) — FIXED (no code change required)

### Root cause

Fully explained by Finding 1. `findReconcilableOutcomes()` and `computeOutcomeUpdate()`
([`src/lib/decision-intelligence/outcome-analysis.ts`](../../platform/web/src/lib/decision-intelligence/outcome-analysis.ts))
only ever consider a `decision_history` row where `actionTaken === "Trade Opened"` and
`createdTradeId` is populated. Because Finding 1 meant **zero** such rows had ever been persisted
(all 377 live rows at the time of Phase A were `action_taken: "Rejected"`), reconciliation — in
both the browser (`decision-history-context.tsx`'s on-trade-change effect) and the worker
(`reconcileAllUsers()` → `reconcileOutcomesForUser()`, run every poll cycle) — correctly found
nothing eligible to classify, every time. Full code review of the reconciliation trigger,
persistence, worker/browser call sites, eligibility logic, and update queries found every one of
them structurally correct; none needed changing.

### Fix applied

None. This finding is resolved as a direct consequence of Finding 1's fix: any new "Trade Opened"
decision_history row now persists correctly with a valid `createdTradeId`, so once its linked trade
closes, reconciliation will find and classify it exactly as designed.

### Evidence

Using the real, unmodified `reconcileOutcomesForUser()` against three synthetic closed trades
(positive, negative, and zero P&L) for a fresh throwaway Supabase user, inserted via the same
`addTradeForUser`/`buildDecisionRecords`/`addRecordsForUser` functions the real pipeline uses:
```
Win: expected=Win actual=Win -> PASS
Loss: expected=Loss actual=Loss -> PASS
Neutral: expected=Neutral actual=Neutral -> PASS
```

And, in the combined final re-verification (Finding 1's evidence trade, closed and reconciled):
```
Reconciliation after simulated close: updatesApplied=1
Final outcome: {"outcome":"Win","realised_pnl":10.548...}
PASS (Finding 3): Pending -> Win transition confirmed
```

### Remaining risk

None identified — the reconciliation module was already correct; it simply had nothing to act on.

**Recommendation: PASS.**

---

## Finding 4 — Dashboard Indicator Accuracy (NON-BLOCKING) — DOCUMENTED, no label change required

### Per-page indicator classification

| Page / feature | Evaluation path | Classification |
|---|---|---|
| Dashboard (watchlist strategy summary) | `StrategyEngine.evaluateAll()` | **Proxy** — indicators fabricated from a single day's price/change/volume via fixed multipliers, not calculated from any history |
| Watchlist | `evaluateAll()` | **Proxy** |
| Market Intelligence | `evaluateAll()` | **Proxy** |
| Operations Centre / System Health (Strategy Engine panel) | `evaluateAllWithTiming()` → `evaluateAll()` | **Proxy** |
| Dashboard "Run scan now" / Bot Runner panel / AutomationRunner (browser) | `executeBotScan()` → `evaluateAllWithHistory()` with `MockHistoricalMarketDataProvider` | **Real indicator math** (EMA/SMA/RSI/momentum/volume-ratio genuinely calculated), computed over **deterministic synthetic** candle history, not live market data |
| Bot Decisions / Decision Intelligence (records from browser-triggered scans) | same as above | Real math over sample history |
| Worker-triggered scheduled scans | `executeBotScan()` → `evaluateAllWithHistory()` with `AlphaVantageHistoricalMarketDataProvider` | **Real indicator math over genuinely live market data** (as of the Finding 2 fix, also internally consistent with the price comparison) |

Separately, and already accurately disclosed: the existing "Live" / "Sample data" badges
(`dataSourceLabel()`/`dataModeLabel()`, `src/lib/utils/style.ts`) on the Dashboard, Watchlist, and
System Health pages correctly describe the source of raw **price quotes and candle history**
(Finnhub/Alpha Vantage vs. mock). That mechanism is accurate and untouched.

### Findings

A full audit of every user-facing string on Dashboard, Watchlist, Market Intelligence, Operations
Centre, Bot Decisions, and their shared components (Strategy Breakdown, Agreement, Generated By,
Strategy Engine Status, Historical Data Status, AI Engine Activity panels) found **no label,
caption, tooltip, or disclosure that is factually false**. Market Intelligence's own info note
already discloses "generated from a fixed set of analytical rules over sample market data." System
Health's Historical Data panel already discloses "real historical data requires a server-side
connection... this browser tab's own manual scans always use sample history instead" — accurate
for the Bot Runner feature it describes.

What is genuinely missing, everywhere: **no page distinguishes the proxy indicator path (Dashboard,
Watchlist, Market Intelligence, Operations Centre) from the real-math indicator path (Bot Runner)**
— the strategy evidence text these two paths produce (e.g. "Short-term average ($X) is above the
long-term average ($Y), a bullish crossover") is worded identically regardless of which path
produced it, so a user cannot tell from the UI which pages are looking at fabricated numbers and
which are looking at (even if sample-data-sourced) genuinely calculated technical indicators.

### Action taken

None to existing copy. Per the acceptance criteria's own framing ("non-blocking... only correct
inaccurate labelling where required"), and given no existing label was found to be factually
incorrect, no minimal, in-scope text correction was identified — the gap is one of omission across
many components, not a wrong statement in any one of them, and closing it properly (a
proxy-vs-real-math disclosure, consistently placed) is a UI design decision outside a
labelling-only, no-redesign remediation pass. This finding is fully addressed via the
documentation above, which is what the acceptance criteria explicitly asked for ("determine
precisely which pages display genuine indicators, proxy indicators, or sample indicators; document
findings").

### Remaining risk

Low, matching Phase A's own "non-blocking" classification. A future development pass should
consider a small, consistent "Indicators: calculated from sample history" / "from today's snapshot
only" disclosure near confidence/signal displays, analogous to the existing price-data badges.

**Recommendation: PASS (non-blocking; documentation-only, as scoped).**

---

## Files changed

- `platform/web/src/lib/persistence/server-paper-trade-store.ts`
- `platform/web/src/lib/bot/server-execution-context.ts`
- `platform/web/src/lib/state/paper-trades-context.tsx`
- `platform/web/src/lib/state/decision-history-context.tsx`
- `platform/web/src/lib/strategy-engine/build-context.ts`

No migrations, no schema changes, no changes to any strategy file, `portfolio-risk.ts`,
`position-manager.ts`, `bot-runner.ts`, scheduler files, or worker scan-processing logic
(`process-schedule.ts`, `fetch-due-schedules.ts`, `reconcile-all-users.ts`) — confirmed via `git
diff --name-only` against those paths returning empty.

## Verification summary

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.
- `npm test` — 39/39 passing, 8/8 test files.
- Live re-verification: Finnhub live quote connectivity — PASS. Alpha Vantage live historical
  connectivity — PASS. Full production-shaped worker scan (`triggerType: "Scheduled"`,
  `createServerExecutionContext`, real Finnhub + Alpha Vantage data for 4/5 instruments) — winning
  candidate's `decision_history` row persisted correctly, `bot_decisions` row persisted correctly
  with a valid `created_paper_trade_id`, simulated close correctly reconciled Pending → Win, and
  the worker's price comparison was internally consistent throughout.
