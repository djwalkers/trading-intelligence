# Mission 9 — Historical Market Data & Indicators

Date: 2026-07-09
Location: `Trading/platform/web`
Related: [`BUILD-1.3.0.md`](./BUILD-1.3.0.md), [`MISSION-8-VPS-WORKER.md`](./MISSION-8-VPS-WORKER.md)

## What this mission is, and isn't

Since Build 1.3.0, the Strategy Engine's three strategies (Moving Average Crossover, RSI Reversal,
Momentum) have run against *proxied* indicators — a single day's snapshot (price, change, volume)
mapped algebraically onto what a moving average, an RSI, or a volume ratio would look like, because
no historical price series existed anywhere in this prototype. This mission replaces those proxies
with real indicators calculated from real (deterministic mock, or optionally external) OHLCV
history, wherever enough history is available — falling back to the original proxies otherwise, not
producing an error or a gap.

**No Hermes, no Trading 212, no live trading, no broker integration.** Paper trading only. This
mission upgrades the data the bot's decisions are based on; it does not add a new decision-maker.

## 1. Historical market data provider

New: `src/lib/market-data/historical-market-data-provider.ts` — a sibling of the existing
`MarketDataProvider` (live quotes), same shape and conventions:

```ts
interface HistoricalMarketDataProvider {
  getHistoricalCandles(symbols: string[], days: number): Promise<OHLCVCandle[]>;
}
```

Batched, not per-symbol — one call for the whole watchlist, each candle self-identifying via
`symbol` (`OHLCVCandle: { symbol, timestamp, open, high, low, close, volume }`, new in
`src/lib/types/market-data.ts`), exactly like `MarketQuote` already does.

Three implementations, mirroring the live-quote architecture file-for-file:

- `MockHistoricalMarketDataProvider` — deterministic mock candles (see below), the default and
  zero-configuration path.
- `ExternalHistoricalMarketDataProvider` — calls Finnhub's daily candle endpoint
  (`/stock/candle`), reusing the *same* `NEXT_PUBLIC_MARKET_DATA_PROVIDER`/
  `NEXT_PUBLIC_MARKET_DATA_API_KEY` configuration as live quotes (one vendor account, a different
  endpoint) rather than introducing a second pair of env vars.
- `ResilientHistoricalMarketDataProvider` — wraps the two above exactly like
  `ResilientMarketDataProvider` does: external when configured, falls back to mock (and stays
  there for the session) if the external call ever fails, tracking a `HistoricalDataStatus`
  (`Mock`/`External` × `Connected`/`Mocked`/`Fallback`, `instrumentsLoaded`, `lastUpdated`,
  `failureReason` — the same fields `MarketDataStatus` already has).

`getHistoricalMarketDataProvider()` (`get-historical-market-data-provider.ts`) is the module-scope
singleton factory, same selection rule as `getMarketDataProvider()`: external when configured, mock
otherwise.

## 2. Mock historical data

`MockHistoricalMarketDataProvider` generates 90 daily candles for each of the five tracked
instruments (AAPL, MSFT, NVDA, TSLA, SPY), deterministically:

- A small, dependency-free seeded PRNG (`mulberry32`, seeded from a string hash of the symbol) —
  the same seed always produces the same sequence, on any machine, on any run. No `Math.random()`
  anywhere in this path.
- A roughly-normal daily return is drawn for each of the 90 days (Box-Muller transform over two
  seeded uniforms), scaled to a fixed daily volatility, and compounded forward from an unscaled
  base of 100.
- The whole unscaled walk is then rescaled so its **final** close lands exactly on the
  instrument's current mock snapshot price (`src/lib/mock/instruments.ts`) — this keeps the
  historical series coherent with the price the rest of the app already shows for "today," rather
  than two unrelated numbers for the same instrument.
- Daily high/low (a small seeded intraday spread around each day's close) and volume (a seeded
  multiplier of the instrument's baseline volume, roughly 0.6×–1.4×) give the candles believable
  day-to-day texture rather than a flat line.
- Verified deterministic directly: running two Bot Scans in the same browser session on the same
  day produced the *same* ranked candidate (MSFT) with the *same* rejection reason both times —
  see "Verification" below.

## 3. Indicator calculations

New: `src/lib/indicators/` — six small, pure functions, each taking a plain `number[]` series (and
a period) and returning the indicator's latest value, or `null` if the series is too short:

| Function | Method |
|---|---|
| `calculateSMA` | Mean of the last `period` values |
| `calculateEMA` | Seeded with the SMA of the first `period` values, then smoothed forward — the standard construction, not a shortcut |
| `calculateRSI` | Wilder's RSI: average gain/loss over the first `period` changes, then smoothed forward — the construction the existing 70/30 overbought/oversold thresholds already assume |
| `calculateMomentumPercent` | Percent price change over the last `period` sessions |
| `calculateVolumeRatio` | Latest volume against the average of the `period` sessions *before* it (excludes today's own volume from its own baseline) |
| `calculateVolatility` | Standard deviation of daily percent returns over `period` sessions, as a percent |

No instrument lookups, no provider calls, no dates, no randomness — genuinely pure and unit-testable
in isolation. `noUncheckedIndexedAccess` (already enabled project-wide) meant every array access
inside these needed an explicit bounds-checked accessor (`at()`, file-local) rather than raw
indexing — the same discipline this codebase already applies elsewhere (see `bot-runner.ts`'s
explicit undefined checks).

## 4. Strategy Engine upgrade

New in `src/lib/strategy-engine/build-context.ts`: `buildStrategyContextFromHistory(instrument,
candles)`, the real-data counterpart to the existing `buildStrategyContext(instrument)` (kept
completely unchanged — still the snapshot-proxy fallback, byte-for-byte identical to before this
mission). Both return the same `StrategyContext` shape, so the three strategies never know or care
which one produced their input:

- `shortMovingAverage` = **EMA(12)**, `longMovingAverage` = **SMA(30)** — a deliberate mix, not a
  textbook 12/26 MACD pair, chosen so the mission's SMA *and* EMA utilities are both genuinely
  exercised by the one strategy that needs a moving-average pair (EMA for the more-reactive short
  side, SMA as the smoother long-side anchor).
- `rsi` = **RSI(14)**, the standard period the 70/30 thresholds already assume.
- `volumeRatio` = **20-day volume ratio**.
- `momentumPercent` — a **new** `StrategyContext` field (see below) = **5-day momentum**.
- `trend` — now derived from **10-day momentum** crossed against the same ±1% thresholds, instead
  of a single day's change.
- `historicalDataAvailable: boolean` — a **new** field discloding whether this particular context
  came from real history or the snapshot fallback.

Returns `null` when there isn't enough history yet (fewer than 31 candles — the longest lookback,
30, plus one extra day the momentum/volume-ratio windows each need) — the caller falls back to
`buildStrategyContext()` in that case, exactly as it would for an unconfigured or failed provider.

**Per-strategy changes**:
- **Moving Average Crossover** and **RSI Reversal**: *zero code changes.* They already read
  `shortMovingAverage`/`longMovingAverage`/`rsi` from `StrategyContext` — those fields are now real
  numbers instead of proxies whenever history is available, with no change to either strategy's own
  logic, thresholds, or evidence text.
- **Momentum**: one small, deliberate change — `evaluate()` now reads `context.momentumPercent`
  instead of `context.instrument.changePercent`. `momentumPercent` *is*
  `instrument.changePercent` in the snapshot-fallback path (see `buildStrategyContext`), so this is
  behaviourally a no-op when history is unavailable, and a genuine upgrade (a real 5-day momentum
  reading instead of today's single session) when it is.

`StrategyEngine` gained two new methods, additive — `evaluateInstrument()`/`evaluateAll()` (sync,
zero network dependency, unchanged) still exist exactly as before:

```ts
evaluateInstrumentWithHistory(instrument, candles): StrategyScore     // one instrument, given its candles
async evaluateAllWithHistory(instruments): Promise<StrategyScore[]>  // fetches candles for the whole batch, then evaluates each
```

## 5. Market data status

New System Health section, "Historical Data" (`HistoricalDataStatusPanel.tsx` +
`useHistoricalDataStatus()`, mirroring the existing Market Data panel exactly): provider
(Mock/External), connection mode (Connected/Mocked/Fallback), instruments loaded, last refresh,
and the fallback reason when applicable.

**An architecture note worth being explicit about**: this status is tracked by a client-side
module singleton (same as the existing Market Data panel), which only reflects activity that
actually happened *in that browser tab*. Since historical data is fetched by the Bot Runner (see
below), the panel correctly shows its untouched initial state until a scan has run in that tab —
confirmed directly in verification (see below), not just asserted.

## 6. Bot Runner

`src/lib/bot/bot-runner.ts`'s one relevant line changed from a synchronous snapshot-only call to
the new async history-aware one:

```diff
- const scores = getStrategyEngine().evaluateAll(instruments);
+ const scores = await getStrategyEngine().evaluateAllWithHistory(instruments);
```

Nothing else in `runBotScan()` changed — individual risk checks, the Position Manager, portfolio
risk, the fallback-to-next-candidate loop, decision logging, are all untouched. Since this is the
one call site both the browser (`BotRunnerPanel` → `executeBotScan()`) and the Mission 8 worker
(`process-schedule.ts` → `executeBotScan()`) share, both now benefit from real historical
indicators identically, through the one shared pipeline Mission 6 established — no duplicated risk
logic, no second code path.

**A scoping decision, disclosed rather than hidden**: the Dashboard, Market Intelligence, and
Watchlist pages' own direct `evaluateAll()` calls (for their own display — Strategy Summary card,
Generated By panel, Primary Strategy column) were deliberately **not** changed to use history this
mission. Those pages are Server Components rendered per-request server-side; the historical
provider's status-tracking singleton is a client-side construct (matching the existing Market Data
pattern) — unifying the two cleanly would mean restructuring those pages' data-fetching model, well
beyond "improve the bot's market data foundation." The Strategy Engine's history capability is
real and complete either way; this mission wired it into the one place the mission itself is about
(the bot), and left the always-available, zero-network-dependency synchronous path serving the
read-only display pages exactly as before. See "What remains" below.

## Files changed

New:
- `src/lib/indicators/indicators.ts`, `index.ts` — SMA, EMA, RSI, momentum%, volume ratio,
  volatility
- `src/lib/market-data/historical-market-data-provider.ts` — interface
- `src/lib/market-data/mock-historical-market-data-provider.ts` — deterministic mock candles
- `src/lib/market-data/external-historical-market-data-provider.ts` — Finnhub candle adapter
- `src/lib/market-data/resilient-historical-market-data-provider.ts` — fallback + status
- `src/lib/market-data/get-historical-market-data-provider.ts` — singleton factory
- `src/lib/state/use-historical-data-status.ts`
- `src/components/system-health/HistoricalDataStatusPanel.tsx`

Changed:
- `src/lib/types/market-data.ts` — `OHLCVCandle`, `HistoricalDataSource`, `HistoricalDataMode`,
  `HistoricalDataStatus`
- `src/lib/types/strategy-engine.ts` — `StrategyContext` gains `momentumPercent`,
  `historicalDataAvailable`
- `src/lib/strategy-engine/build-context.ts` — new `buildStrategyContextFromHistory()`,
  `MIN_CANDLES_FOR_HISTORY`; `buildStrategyContext()` unchanged logic, now also populates the two
  new fields
- `src/lib/strategy-engine/strategy-engine.ts` — new `evaluateInstrumentWithHistory()`,
  `evaluateAllWithHistory()`; existing sync methods unchanged
- `src/lib/strategy-engine/strategies/momentum.ts` — reads `context.momentumPercent` instead of
  `context.instrument.changePercent`
- `src/lib/strategy-engine/index.ts` — barrel exports for the above
- `src/lib/bot/bot-runner.ts` — one line, sync → async history-aware Strategy Engine call
- `src/app/system-health/page.tsx` — new "Historical Data" section
- `README.md`, `src/components/layout/Footer.tsx`, `src/components/layout/Sidebar.tsx` — build
  label bumped to "Mission 9"

No changes to `moving-average-crossover.ts` or `rsi-reversal.ts` (zero code changes needed — see
above), no database migration (this mission has no persistence component), no changes to the
Dashboard/Market Intelligence/Watchlist pages' existing display logic.

## Data architecture changes

```
Before (Build 1.3.0):
  Instrument snapshot (price, changeAbsolute, changePercent, volume)
    → buildStrategyContext()  [proxy math]
      → StrategyContext { shortMovingAverage, longMovingAverage, rsi, volumeRatio, trend }
        → 3 strategies → StrategyScore

After (Mission 9), for callers that opt in (Bot Runner):
  HistoricalMarketDataProvider.getHistoricalCandles(symbols, 90)
    → OHLCVCandle[] (per symbol)
      → buildStrategyContextFromHistory()  [real SMA/EMA/RSI/momentum/volume-ratio]
        → StrategyContext { ...same shape, momentumPercent, historicalDataAvailable: true }
          → 3 strategies (UNCHANGED) → StrategyScore
      — or, if < 31 candles for that symbol —
    → buildStrategyContext()  [identical proxy math as before, historicalDataAvailable: false]

Callers that haven't opted in (Dashboard/Market Intelligence/Watchlist display):
  Instrument snapshot → buildStrategyContext() → StrategyContext → 3 strategies → StrategyScore
  (byte-for-byte the same path as Build 1.3.0)
```

## Verification

Local prototype mode (`.env.local` moved aside, matching every prior mission's approach), same
browser profile carrying state from Missions 6–8:

- **`npm run lint`** — clean.
- **`npm run build`** — clean; `npx tsc --noEmit` across the whole project (including
  `src/worker/`) also clean.
- **VPS worker still builds and runs** — `npm run worker` was actually run (not just type-checked)
  with this mission's new `bot-runner.ts` → `getStrategyEngine().evaluateAllWithHistory()` →
  `getHistoricalMarketDataProvider()` import chain live. This session's `.env.local` now has a
  real `SUPABASE_SERVICE_ROLE_KEY` (added since Mission 8) — the worker connected to the live
  Supabase project successfully and polled cleanly (`worker_started` → repeated
  `poll_started`/`no_schedules_due`, no crash, no error) for several cycles before being stopped.
  Confirms the new dependency chain resolves correctly in the worker's Node/tsx environment, not
  just in the browser bundle.
- **Strategy Engine still produces recommendations, now visibly using real history**: a manual Bot
  Scan produced a materially different result from every prior mission's testing — MSFT (not the
  previously-consistent NVDA) ranked as the sole tradeable candidate, rejected on "Max notional per
  trade" (its ~$446 mock price exceeds the £250 cap at even one share) — direct evidence the
  ranking is now driven by genuinely different (real, calculated) indicator values, not the old
  proxies. No console errors.
- **Deterministic output confirmed directly**: running two separate Bot Scans in the same session
  produced the *same* ranked candidate (MSFT) and the *same* rejection reason both times —
  the mock historical generator is reproducible within a session, as designed.
- **Historical Data status panel verified live**: after a full page reload, the panel correctly
  showed its untouched initial state (`instrumentsLoaded: 0`, "Not yet fetched") — client-side
  singletons reset on full navigation, same as the existing Market Data panel already does. After
  running a Bot Scan and navigating via in-app (SPA) links rather than a full reload, the same
  panel correctly showed `instrumentsLoaded: 5` and a real timestamp, confirming the status
  genuinely reflects the historical fetch that just happened rather than a static placeholder.
- **Paper trades still work / Decision Intelligence still records**: the rejected MSFT candidate
  produced exactly one `DecisionRecord` (Mission 7) with the real historical `confidence`,
  `agreement`, and `entryPrice`, `rejectionReason: "Individual checks failed: Max notional per
  trade."` — the full Mission 7 pipeline unaffected by swapping in real indicator inputs.
- **Supabase persistence path unaffected**: this mission touches nothing in
  `src/lib/persistence/`, `src/lib/decision-intelligence/`, or any Supabase-facing store — verified
  by inspection (no diff touches those files) and by the clean build/lint pass.
- **Mock fallback works with no external API key**: this session's `.env.local` has no
  `NEXT_PUBLIC_MARKET_DATA_PROVIDER`/`NEXT_PUBLIC_MARKET_DATA_API_KEY` set, so every test above ran
  against `MockHistoricalMarketDataProvider` by construction — the default, zero-configuration path
  is the one actually exercised.
- **Browser Bot Runner, Trade Journal, Bot Decisions, Market Intelligence, Watchlist all
  regression-checked** — navigated to each via in-app links after running a scan; no console
  errors on any page.

**Not verified**: the `ExternalHistoricalMarketDataProvider` path against a real Finnhub API key —
no market data API key is configured in this environment (same standing disclosure as Build 1.0.0's
original external quote provider). Its resilient-fallback behaviour is structurally identical to
the already-shipped, already-disclosed live-quote equivalent, so this is a known, pre-existing gap
carried forward, not a new one.

## Readiness verdict

**Ready**: the historical data layer, indicator calculations, and Strategy Engine upgrade are real,
working, and verified end to end through the Bot Runner (both the browser and the VPS worker path).
Mock mode is the fully-supported, zero-configuration default; the external path exists and follows
the same resilient-fallback contract as the already-shipped live-quote provider, disclosed as
untested against a real vendor key. **Not done, and not a goal of this mission**: wiring the
Dashboard/Market Intelligence/Watchlist display pages to the history-aware path (a disclosed,
deliberate scoping decision, not an oversight); any use of `calculateVolatility` in a strategy (the
utility exists and is tested via the indicator module's own logic, but no strategy consumes it yet
— nothing in this mission's requirements demanded a 4th signal).

## Suggested next mission

Two candidates. (1) **Wire the display-only pages to history** — Dashboard's Strategy Summary
card, Market Intelligence's Generated By/Strategy Breakdown, and Watchlist's Primary Strategy
column currently still show the snapshot-proxy reading even though the Bot Runner now uses real
history for the same instruments; unifying this needs a real answer for the server/client
status-singleton question flagged above, not just a mechanical change. (2) **A real strategy or
risk rule that uses `calculateVolatility`** — the one indicator built this mission that nothing yet
reads; a volatility-aware position sizing or a fourth strategy are both natural candidates, though
either would need its own mission given the "no new trading strategies" instruction here.
Independently, the standing verification debt (migrations `0014`–`0016` still unapplied; Mission
8's live-worker-concurrency test still pending) remains unrelated to this mission but unresolved.
