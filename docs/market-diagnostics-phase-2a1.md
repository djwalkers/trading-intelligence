# Internal Market Diagnostics UI — Phase 2A.1

## Purpose

`/market-intelligence/diagnostics` is an internal, read-only page for inspecting the live trading
pipeline's own market-data quality and indicator calculations — without using TradingView. It
exists purely for **operational verification and debugging**: confirming that the currently
configured provider (live eToro or mock), the historical candle fetch, and the EMA20/EMA50/RSI14/
ATR14/trend calculations are behaving as expected, and catching problems (stale data, malformed
candles, a misconfigured broker) at a glance.

It is not a trading tool, a signal generator, or a source of investment advice.

## Read-only, by construction

This page — and everything behind it — can never place an order, close a position, change
strategy configuration, restart the runtime, or modify environment variables. Concretely:

- The shared service it calls, `getMarketDiagnostics()`
  (`platform/web/src/lib/hermes-execution/market-diagnostics-service.ts`), only ever calls
  read-only methods: `getRate`, `getHistoricalCandles`, `resolveInstrument`, and the existing
  `MarketIntelligenceBuilder`/`technical-indicators.ts` calculation functions. It never
  constructs an `OrderRequest` and never calls `placeMarketOrder`/`closePosition`.
- It never touches `MarketDecisionEngine`, strategy rules, the risk engine, position sizing, the
  scheduler, or Telegram — none of those files were modified to build this feature, and the
  service doesn't import any of them.
- The page's own audit trail is an `InMemoryAuditTrail` that is discarded when the request
  finishes — nothing it does is ever persisted as if it were part of a real trading cycle.

## How it obtains data

There is **one** shared implementation — `getMarketDiagnostics()` — used by three different
entry points, so indicator math is never duplicated or able to drift between them:

1. **`npm run market:diagnostics`** — a CLI command for manual verification from a terminal
   (`platform/web/src/hermes-execution/market-diagnostics.ts`).
2. **`GET /api/hermes/market-diagnostics`** — an external, bearer-token-authenticated API route
   (the same `withHermesGuard` pattern every other `/api/hermes/*` route uses), for the Hermes
   Agent or a manual `curl` check from the VPS. Never cached (`Cache-Control: no-store`).
3. **The page itself** — a Next.js Server Action
   (`platform/web/src/app/market-intelligence/diagnostics/actions.ts`) that the page's "Refresh"
   button and its 60-second auto-refresh both call. This deliberately does **not** go through the
   bearer-token-gated API route — the `HERMES_INTEGRATION_TOKEN` that route requires must never
   reach the browser. The Server Action runs server-side only and calls the exact same shared
   service; the page itself is gated by the app's own sign-in (`AuthGate`), like every other page.

Provider selection is **config-driven**: `getMarketDiagnostics()` reads
`HERMES_MARKET_DATA_PROVIDER`/`BROKER_PROVIDER` exactly as the real continuous runtime does
(`runtime-dependency-factory.ts`), and reports which one is actually active as the "Live" or
"Mock" badge at the top of the page. This is a deliberate change from this feature's original CLI
script, which always forced a live eToro connection regardless of configuration — that doesn't fit
a page whose whole job is to show truthfully whether the *currently deployed* pipeline is live or
mock.

Historical candles come from eToro's own candle-history endpoint
(`EtoroClient.getHistoricalCandles`, wired through `EtoroDemoBroker.getHistoricalCandles`) when
`HERMES_MARKET_DATA_PROVIDER=live`, or from the deterministic synthetic generator
(`MockMarketDataProvider`) when it's `mock`. Both are the same, unmodified code the real trading
runtime uses — this feature added a service and a UI on top; it did not change how candles are
fetched or validated.

## What each indicator means

Every value on the page comes from `technical-indicators.ts`'s existing, unmodified formulas —
this feature only calls them, it never reimplements or tweaks them.

- **EMA20** — the average closing price over the most recent ~20 candles, weighted toward recent
  data. A short-term trend reference.
- **EMA50** — the same idea over ~50 candles. A longer-term trend reference. EMA20 sitting above
  EMA50 indicates short-term price is above the longer-term average; below indicates the reverse.
- **RSI14** — Relative Strength Index over 14 periods, on a 0–100 scale. Near 50 is neutral; above
  70 is often read as overbought, below 30 as oversold — neither is a signal on its own.
- **ATR14** — Average True Range over 14 periods. Measures how much price has recently moved
  (volatility), not which direction it moved.
- **Trend** — a simple Bullish/Bearish/Sideways classification of whether EMA20 sits above, below,
  or close to EMA50.

None of this is financial advice, and the page never presents it as a recommendation.

## Interpreting data-age and fallback status

- **Candle data age** is how old the most recently closed candle is, compared against
  `HERMES_MARKET_MAX_CANDLE_AGE_SECONDS` (the same threshold `candle-validation.ts` enforces on
  the live trading runtime). The status header shows **Fresh** below 60% of that threshold,
  **Aging** from 60–90%, and **Near stale threshold** above 90%. Data that has actually crossed
  the threshold never reaches the page as a successful result at all — `candle-validation.ts`
  already rejects it before `getMarketDiagnostics()` can return, and the page shows an error
  banner instead (see "Error handling" below). The freshness badge is an early warning for data
  that's aging but still passed, not a report of a failure that already happened.
- **Fallback status** is always "No fallback" — there is no fallback path anywhere in this
  pipeline (a failed live fetch always throws rather than silently substituting mock/synthetic
  data), so this badge exists to make that invariant visible, not to report a real toggle.

## Why eToro volume may display as "unavailable"

eToro's own documented API schema declares candle volume as a required, always-numeric field —
but a real live response has been observed (via `market:diagnostics`) to return `null` for it,
contradicting that documentation. This pipeline treats that as confirmed live behaviour: volume is
optional throughout (`Candle.volume?: number`), and a missing volume is reported honestly as
"Unavailable" rather than fabricated as zero or hidden. Missing volume is never treated as a
validation failure — OHLC and timestamp remain mandatory and are unaffected, and no indicator
shown on this page uses volume in its calculation at all (EMA/RSI/ATR/trend are all price-only).

## Read-only confirmation

To restate plainly: this page cannot place an order, close a position, alter strategy
configuration, restart the runtime, or modify environment variables. It reads market data and
displays it — nothing more. If you need to test order placement or strategy behaviour, use the
existing, separate smoke-test CLIs (`broker-etoro-smoke.ts`, `market-decide.ts`, etc.), not this
page.
