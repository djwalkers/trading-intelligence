# Build 0.5.0 — Closing the Loop: Realised P/L

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.1.0.md`](./BUILD-0.1.0.md), [`BUILD-0.1.1.md`](./BUILD-0.1.1.md),
[`BUILD-0.2.0.md`](./BUILD-0.2.0.md), [`BUILD-0.3.0.md`](./BUILD-0.3.0.md),
[`BUILD-0.4.0.md`](./BUILD-0.4.0.md)

## What was built

Every paper trade placed since Build 0.2.0 has stayed open forever. This build completes the
loop: open trades can now be **closed**, producing a **realised P/L**, and both realised and
unrealised performance are visible on the Dashboard, Paper Portfolio, and Trade Journal.

- **Close Trade action.** Every open trade — wherever it's listed (Paper Portfolio's trade
  tables, Trade Journal) — has a "Close Trade" button. Clicking it opens a confirmation modal
  showing instrument, side, quantity, entry price, **current mock price**, and the **estimated
  realised P/L**, plus a warning that this is paper trading only and closing places no real order.
- **A mock "current price" that can actually move.** Until now, an instrument's mock price never
  changed, so closing a trade the moment it opened would always show exactly £0 P/L — a
  realised-P/L feature that always shows zero is indistinguishable from a broken one. Each
  instrument now has a small, fixed, disclosed drift (e.g. NVDA +2.8%, TSLA −2.4%) applied on top
  of its base mock price via `getCurrentMockPrice()`. This **only** affects paper trade
  entry/exit math — the Watchlist, Dashboard, and every other instrument price display are
  completely unaffected.
- **Paper Portfolio** now shows a "Paper trading performance" panel (open/closed trade counts,
  realised/unrealised/total P/L), and the former single "Recent paper trades" section is split
  into **Open trades** and **Closed trades** — both with a "View all" link to Trade Journal, and
  the open-trades table carries the Close Trade action.
- **Trade Journal** shows exit price, close timestamp, and realised P/L (with percent) on every
  closed trade, and gained two more filters — **Open** and **Closed** — alongside the existing
  All / Signals / Market Intelligence / BUY / SELL, for seven filters in total.
- **Dashboard** gained a compact "Paper trading performance" summary (open trades, closed trades,
  realised P/L, unrealised P/L), linking to the full Paper Portfolio view.

## Type / model changes

`PaperTrade` gained four new **optional** fields, populated only once a trade is closed:

- `exitPrice?: number`
- `closedAt?: string`
- `realisedPnl?: number`
- `realisedPnlPercent?: number`

`status` was already `"Open" | "Closed"` since Build 0.2.0 — this build is what finally makes
`"Closed"` reachable.

**Backward compatibility:** every trade saved before this build has `status: "Open"` already
(closing didn't exist yet, so no old trade can already be "Closed"), and the four new fields are
optional, so old records need no migration — they load and display exactly as open trades, with a
working Close Trade action. This was verified directly against a hand-seeded Build 0.4.0-format
record.

## New architecture

- `src/lib/utils/paper-trade.ts` gained the P/L engine: `getCurrentMockPrice`,
  `calculateTradePnl`, `calculateTradePnlPercent`, `buildClosedTrade`, and
  `calculatePaperTradePerformance` (aggregate open/closed counts and realised/unrealised/total
  P/L) — one shared, side-aware (BUY vs. SELL) formula used everywhere a P/L number appears.
- `PaperTradesProvider` gained `updateTrade(updatedTrade)`, a generic replace-by-id method,
  alongside the existing `addTrade`.
- **`useCloseTradeFlow()`** (`src/lib/state/use-close-trade-flow.ts`) is a small shared hook
  wrapping the "request close → confirm → cancel" state, used identically by both the Paper
  Portfolio page and Trade Journal, so the close-trade wiring exists in exactly one place rather
  than being copy-pasted into both.
- **`CloseTradeModal`** is a new, dedicated component (not a reuse of the open-trade
  `PaperTradeModal`) — its fields and purpose (current price, estimated P/L) are different enough
  from opening a trade that forcing one modal to serve both would have made both harder to read.
- `StatCard` gained an optional `valueClassName` prop so P/L figures can colour their primary
  number directly (existing usages are unaffected — the prop defaults to the same neutral colour
  as before).

## Fixed while touching this code

`PortfolioView`'s cash balance calculation previously summed committed capital across **all**
trades regardless of status. That was harmless when every trade was permanently open, but once
trades can close, unclosed capital must be excluded and realised P/L must flow back into cash. The
formula is now: `starting cash − (open trades' committed capital) + (realised P/L)`, verified
against hand-calculated figures during manual testing (e.g. £3,250.00 − £269.74 + £7.24 =
£2,987.50, matching the UI exactly).

## What is intentionally not included yet

- No partial closes — a trade closes in full, at its full quantity.
- No live or scheduled price movement — the mock price drift is fixed per instrument, not
  time-based.
- No real market data, broker connection, AI, or live execution (unchanged from prior builds).
- No persistence beyond the browser's `localStorage` (unchanged).

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open a paper trade from Signals or Market Intelligence, then close it from the Paper Portfolio or
Trade Journal page to see realised P/L flow through. `npm run lint` and `npm run build` both pass
cleanly. Manually verified in this build: a hand-seeded pre-0.5.0 trade loads and closes
correctly; new Signal and Market Intelligence trades can both be opened and closed (BUY and SELL);
Dashboard, Paper Portfolio, and Trade Journal all reflect the correct realised/unrealised figures
after each close; and all data survives a full page reload.

## Next recommended build

**Build 0.6.0**: introduce a database (Supabase) behind the existing type contracts in
`src/lib/types`, moving paper trades — now including their full open/closed lifecycle — from
`localStorage` into real persistence so history survives across devices. A live (even if still
mocked/delayed) price feed to replace the fixed per-instrument drift would be a natural companion
piece once real persistence exists.
