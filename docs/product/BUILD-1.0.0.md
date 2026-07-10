# Build 1.0.0 — Market Data Layer

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`BUILD-0.9.0.md`](./BUILD-0.9.0.md), [`../../platform/web/.env.example`](../../platform/web/.env.example)

## What was built

A `MarketDataProvider` abstraction now sits between every instrument price shown in the app and
its source. **The app still runs with zero market data configuration** — mock prices remain the
default and the fallback, exactly as the brief required.

- **`MarketDataProvider` interface** (`src/lib/market-data/market-data-provider.ts`) — one method,
  `getQuotes(symbols: string[]): Promise<MarketQuote[]>`. Batched, not per-symbol, so a real
  provider can fetch a whole watchlist in one round trip.
- **`MockMarketDataProvider`** — wraps `src/lib/mock/instruments.ts` and applies the same fixed
  per-instrument drift previously duplicated inside `lib/utils/paper-trade.ts` (Build 0.5.0), now
  promoted here as the single source of "current mock price." Change/percent are re-derived
  against an implied previous close so price, change, and percent always agree with each other.
- **`ExternalMarketDataProvider`** — a real HTTP implementation, not a stub. Calls Finnhub's public
  quote endpoint (`https://finnhub.io/docs/api/quote`), chosen as the first concrete adapter
  because it has a genuinely free tier and the simplest contract of the major quote APIs. Never
  instantiated unless both new environment variables are set.
- **`ResilientMarketDataProvider`** — wraps whichever provider is active with the mock provider as
  fallback, mirroring `ResilientPaperTradeStore` from Build 0.9.0 exactly: external is tried first
  when configured; if it ever throws, the failure is logged once, the provider falls back to mock
  for the rest of the session (no repeated retries against a connection already known to be
  broken), and a `MarketDataStatus` object is kept in sync via a small pub-sub, consumed through
  `useMarketDataStatus()`.
- **Store/provider selection**: `getMarketDataProvider()` picks the external provider when
  `NEXT_PUBLIC_MARKET_DATA_PROVIDER` and `NEXT_PUBLIC_MARKET_DATA_API_KEY` are both set, mock
  otherwise — cached at module scope so every component shares one instance and one status.
- **`useMarketQuotes(symbols)`** — loads quotes once per distinct symbol set (keyed on the sorted,
  joined symbol list, not array identity) and caches them in component state; no polling.
- **Watchlist**, now `WatchlistView` (client) wrapping the existing `WatchlistTable`, shows current
  price, daily change value + percent (recomputed consistently against the live price), a
  per-instrument last-updated timestamp, and a Mock/External source badge. Falls back to mock
  automatically if the external provider fails — no special-case error UI needed, since the
  resilient wrapper already serves mock quotes transparently.
- **Portfolio valuation**: `calculatePaperTradePerformance` and the paper trades tables now take
  prices from the provider (via `useMarketQuotes`) instead of calling a hardcoded mock function
  internally. `PaperTradesTable` gained a "Current price" column for open trades. Closing a trade
  (`useCloseTradeFlow`) now fetches the live quote for that symbol at the moment "Close Trade" is
  clicked, and the modal shows "Fetching current price…" for the brief window before it resolves.
- **Dashboard** gained a "Market Data Status" card: provider, mode, last updated, instruments
  loaded, and whether fallback is active.
- **System Health** gained a live "Market Data" panel (provider, connection/mode, last successful
  refresh, failure reason if applicable), replacing the static, stale "Market Data: Mocked" mock
  service row that had been unchanged (and increasingly inaccurate) since Build 0.1.0.

## Provider architecture notes

```
MarketDataProvider (interface)
├── MockMarketDataProvider       — wraps lib/mock/instruments.ts + fixed drift table
└── ExternalMarketDataProvider   — real fetch() call to Finnhub's quote endpoint

ResilientMarketDataProvider (implements MarketDataProvider)
  wraps: primary (External, if configured) + fallback (Mock)
  tracks: MarketDataStatus, pushed to subscribers on every change

getMarketDataProvider()          — module-singleton factory, chooses primary vs. null
useMarketQuotes(symbols)         — per-symbol-set cache, one fetch per distinct set
useMarketDataStatus()            — subscribes to the resilient provider's status
```

The same shape as Build 0.9.0's persistence stack, deliberately: interface → mock implementation →
real implementation → resilient fallback wrapper → module singleton → React hook. Reusing a
pattern already reviewed and shipped kept this build's risk low despite touching five pages.

**Why Finnhub as the concrete external adapter, rather than a pure placeholder that always
throws:** the brief asked for a "placeholder/implementation," and a genuinely callable adapter is
more useful than an inert stub — someone with a free Finnhub API key can flip this on today and see
real quotes. Swapping vendors later means adding a sibling class next to
`ExternalMarketDataProvider` and a branch in `get-market-data-provider.ts`; the interface, the
resilient wrapper, the hooks, and every UI component are unaffected either way.

**Why prices flow through props/hooks instead of a synchronous global lookup:** the old
`getCurrentMockPrice(symbol)` was synchronous because mock math has no I/O. A real market data
fetch is inherently asynchronous, so every call site that used to call it directly
(`calculatePaperTradePerformance`, `buildClosedTrade`, both `CloseTradeModal` callers) was changed
to receive prices as data (a `pricesBySymbol` map, or an explicit `exitPrice` parameter) rather than
fetching them internally. `useMarketQuotes` is the one place that owns the async fetch; everything
downstream is a pure function of the prices it's given.

**Why Watchlist's displayed daily change no longer matches Build 0.1.0's authored mock values
exactly:** previously, Watchlist showed the instrument's static `changeAbsolute`/`changePercent`
from `lib/mock/instruments.ts`, while paper trade P/L (Build 0.5.0) separately applied its own
price drift — two different "current price" concepts that never appeared on the same page
together, so the inconsistency was invisible. Now that Watchlist and Portfolio both read from the
same `MarketDataProvider`, `MockMarketDataProvider` re-derives change/percent from an implied
previous close (`instrument.price - instrument.changeAbsolute`) against the drifted price, so the
three numbers always agree. This is a correctness fix enabled by unification, not a regression —
no stored trade data or P/L formula changed.

## Files changed

New:
- `src/lib/types/market-data.ts` — `MarketQuote`, `MarketDataMode`, `MarketDataStatus` types
- `src/lib/market-data/market-data-provider.ts` — interface
- `src/lib/market-data/mock-market-data-provider.ts`
- `src/lib/market-data/external-market-data-provider.ts`
- `src/lib/market-data/resilient-market-data-provider.ts`
- `src/lib/market-data/config.ts` — `isExternalMarketDataConfigured()`
- `src/lib/market-data/get-market-data-provider.ts` — singleton factory
- `src/lib/state/use-market-quotes.ts`
- `src/lib/state/use-market-data-status.ts`
- `src/components/watchlist/WatchlistView.tsx`
- `src/components/dashboard/MarketDataStatusCard.tsx`
- `src/components/system-health/MarketDataStatusPanel.tsx`

Changed:
- `src/lib/utils/paper-trade.ts` — removed `getCurrentMockPrice` + its drift table (moved into
  `MockMarketDataProvider`); `calculatePaperTradePerformance` now takes `pricesBySymbol`;
  `buildClosedTrade` now takes `exitPrice` as a parameter
- `src/lib/state/use-close-trade-flow.ts` — `requestClose` is now async and fetches a live quote;
  exposes `currentPrice` (nullable while loading) and `isPriceLoading`
- `src/components/trading/CloseTradeModal.tsx` — handles a loading price state; disables Confirm
  until a price has resolved
- `src/components/portfolio/PortfolioView.tsx`, `src/components/trading/TradeJournalView.tsx` —
  updated for the new close-trade-flow shape
- `src/components/dashboard/PaperTradingSummary.tsx` — sources prices via `useMarketQuotes`
- `src/components/tables/PaperTradesTable.tsx` — new "Current price" column for open trades
- `src/components/tables/WatchlistTable.tsx` — current price/change now come from an optional
  `quotes` prop, plus a last-updated column and an optional source badge
- `src/app/watchlist/page.tsx`, `src/app/page.tsx` — use `WatchlistView`; Dashboard adds the Market
  Data Status panel
- `src/app/system-health/page.tsx` — adds the Market Data panel; build label bumped to 1.0.0
- `src/lib/mock/system-health.ts` — removed the stale static "Market Data: Mocked" row
- `src/components/layout/Sidebar.tsx`, `src/components/layout/Footer.tsx` — build label bumped;
  wording no longer claims mock-only pricing
- `.env.example` — recreated (see note below) with the two new variables documented

**Note on `.env.example`:** this file was found missing at the start of this build — it had been
accidentally deleted in the commit that validated Supabase persistence. It has been recreated here
with corrected Supabase wording (the old comment said configuring Supabase "does not switch
persistence yet," which stopped being true in Build 0.9.0) plus the two new market data variables.

## What is intentionally not included yet

- No real trading: no broker execution, no live order placement, exactly as instructed.
- No AI, no "Hermes," exactly as instructed.
- Signal and Market Intelligence entry prices (`buildPaperTradeFromSignal`,
  `buildPaperTradeFromOpportunity`) still use the static mock instrument price, not the live
  provider — out of scope for this build, which was about pricing existing positions and the
  Watchlist, not trade entry.
- The static "Open positions" table on Paper Portfolio (`PositionsTable`, pre-existing demo data
  from Build 0.1.0, unrelated to trades placed via Signals/Market Intelligence) is unchanged —
  only the user's own paper trades (`PaperTradesTable`) are valued through the new provider.
- Only one external adapter exists (Finnhub-shaped). `NEXT_PUBLIC_MARKET_DATA_PROVIDER` is
  currently a display label, not a multi-vendor selector.
- No caching/rate-limit handling beyond "load once per distinct symbol set" — there is no retry,
  backoff, or per-symbol partial-failure handling; a batch either succeeds or the whole batch falls
  back to mock.
- No historical price data, charts, or intraday movement — a single current quote per symbol.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. To try a live external feed: get a free API key from
[finnhub.io](https://finnhub.io), copy `.env.example` to `.env.local`, and set
`NEXT_PUBLIC_MARKET_DATA_PROVIDER=Finnhub` and `NEXT_PUBLIC_MARKET_DATA_API_KEY=<your key>`.

`npm run lint` and `npm run build` both pass cleanly. Manually verified in this build:

- The app builds and runs correctly with no market data environment variables — Watchlist,
  Portfolio, Dashboard, and System Health all show mock prices and a "Mock" / "Mocked" status.
- Using a syntactically valid but fake provider/key pair, the external provider fails on first
  fetch: the app does not crash, logs `[market-data] External provider unavailable, falling back to
  mock` with the underlying error, System Health's Market Data panel shows mode "Fallback" with the
  failure reason, the Dashboard card shows "Fallback active," and Watchlist/Portfolio continue
  showing correct mock-derived numbers for the rest of the session.
- The full paper trading lifecycle (place from Signals, place from Market Intelligence, close a
  trade) continues to work, including the new brief "Fetching current price…" state in the close
  modal.
- Supabase persistence (Build 0.9.0) continues to work unaffected — this build did not touch the
  persistence layer.
- Trade Journal filters, history, and realised P/L display are unchanged.
- Portfolio's realised/unrealised/total P/L figures update correctly using provider-sourced prices,
  and match the same figures shown on the Dashboard's paper trading summary.

**Not live-tested against a real Finnhub API key** — no key was available in this environment, so
the "successfully connected to a real external provider" path is implemented and reviewed (the
request/response shape matches Finnhub's documented contract) but not live-verified end-to-end.
Anyone adopting this should verify that path against their own key before relying on it.

## Maintenance Build 1.0.1

Housekeeping pass to leave Build 1.0.0 clean before the next major milestone. No functional or
architectural changes.

- **Removed the TSLA verification trade.** Build 1.0.0's manual testing placed and closed one real
  paper trade (TSLA, Signal-sourced, entry $248.19 / exit $242.23, realised P/L −5.96) against the
  connected Supabase project to verify the close-trade flow end-to-end. That row (and its two
  `trade_events` rows — 'opened' and 'closed'; it had no `trade_intelligence` row, since it came
  from a Signal, not Market Intelligence) has been deleted. `trade_events.paper_trade_id` and
  `trade_intelligence.paper_trade_id` both already declare `on delete cascade`
  (`supabase/migrations/0002...`, `0003...`), so deleting the `paper_trades` row was sufficient —
  no manual child-table cleanup was needed, though it was verified explicitly (see below) rather
  than assumed.
- **Trade Journal footer wording fixed.** It previously always claimed trade history was "stored
  locally in your browser only (localStorage)," which stopped being accurate the moment Build
  0.9.0 added real Supabase persistence. It now reads the live `usePersistenceStatus()` and states
  which provider is actually active: *"Trade history is stored using the active persistence
  provider — currently Supabase [or local browser storage]. Supabase is used when configured;
  local browser storage is used as a fallback."*

**Files changed:**
- `src/components/trading/TradeJournalView.tsx` — footer copy now sources the active mode from
  `usePersistenceStatus()` instead of a hardcoded claim
- No other application files changed — Task 1 was a one-time data cleanup against the live
  Supabase project, not a code or schema change

**Verified:**
- Before deletion: `paper_trades` held 3 rows (NVDA +7.56, MSFT +4.85, TSLA −5.96); the TSLA row's
  `trade_events` had exactly 2 rows (opened, closed) and 0 `trade_intelligence` rows.
- After deletion: querying `paper_trades` for `instrument_symbol = 'TSLA'` returns zero rows;
  querying `trade_events`/`trade_intelligence` for the deleted row's id returns zero rows (no
  orphans); `paper_trades` now holds exactly the original 2 rows (NVDA, MSFT), realised P/L total
  +12.41.
- In the running app: Trade Journal shows "2 trades recorded" (NVDA, MSFT only) with the new
  footer wording ("currently Supabase"); Paper Portfolio shows Realised P/L +12.41, Total paper P/L
  +12.41, cash balance back to £3,262.41 — matching the pre-verification baseline exactly; Dashboard
  and System Health both load correctly, with System Health's Persistence panel showing Supabase
  Connected.
- `npm run lint` and `npm run build` both pass cleanly. No console errors.

## Suggested Build 1.1.0

With market data now pluggable and persistence now real (Build 0.9.0), the two biggest remaining
gaps toward feeling like a real product are authentication (still the permissive RLS placeholder
from Build 0.7.0) and giving Market Intelligence's entry pricing the same live-provider treatment
this build gave existing positions. Suggested scope for 1.1.0: real user accounts (Supabase Auth),
`user_id`-scoped RLS policies replacing the permissive placeholders, and routing new trade entry
prices (Signals, Market Intelligence) through `MarketDataProvider` instead of the static mock
instrument price — so a paper trade's entry price and its ongoing valuation come from the same
source for the first time.
