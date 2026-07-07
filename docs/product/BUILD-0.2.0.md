# Build 0.2.0 — Interactive Paper Trading Prototype

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.1.0.md`](./BUILD-0.1.0.md), [`BUILD-0.1.1.md`](./BUILD-0.1.1.md)

## What was built

Turned the static dashboard into an interactive paper-trading prototype, using local browser
state only — no backend, no database.

- **Paper Trade action on signals** — every BUY or SELL signal (on the Dashboard and Signals
  page) now has a "Paper Trade" button. HOLD signals are explicitly marked "Not tradeable" and
  have no action.
- **Risk warning confirmation modal** — clicking "Paper Trade" opens a modal previewing the trade
  (instrument, side, mock quantity, mock entry price, strategy, confidence) with the warning "This
  is prototype paper trading only. No real order will be placed." The trade is only recorded if
  the user confirms; Cancel or Escape discards it.
- **Local paper trade state** — confirmed trades are held in a React context
  (`PaperTradesProvider`) and persisted to the browser's `localStorage`
  (`trading-intelligence.paper-trades.v1`), so they survive a page reload but never leave the
  browser. Once a signal has been traded, its row shows a "Trade placed" badge instead of the
  button, preventing duplicate trades from the same signal.
- **Trade fields** — each paper trade records instrument, side (BUY/SELL), a mock quantity sized
  to roughly a fixed notional exposure, mock entry price (the instrument's current mock price),
  timestamp, the originating signal's confidence and strategy name, and a status of `Open`.
- **Paper Portfolio updates** — the portfolio page now shows a "Recent paper trades" section and
  an adjusted cash balance that reflects capital committed to open paper trades. Total portfolio
  value is intentionally unchanged at the moment a trade opens (entry price = current mock price,
  no slippage modelled), which is noted directly on the page.
- **Trade Journal page** — a new page listing every paper trade placed this session/browser, with
  its source signal's strategy, confidence, and reason, plus its status.
- **Navigation** — "Trade Journal" added to the sidebar and mobile nav between Paper Portfolio and
  Strategies.

## What is intentionally not included yet

- No backend, database, or cross-device sync — trades live only in the current browser's
  `localStorage`.
- No trade closing, position netting, or P/L simulation on open paper trades.
- No real broker connection, live market data, AI-generated signals, authentication, or financial
  advice language (unchanged from prior builds).

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open `http://localhost:3000`, go to **Signals**, and click **Paper Trade** on any BUY or SELL row
to try the flow. `npm run lint` and `npm run build` both pass cleanly on this build.

## Next recommended build

**Build 0.3.0**: introduce a persistence layer (Supabase) behind the existing type contracts in
`src/lib/types`, moving paper trades from `localStorage` into a real database so history survives
across devices and browsers, and lay the groundwork for trade closing / realized P/L.
