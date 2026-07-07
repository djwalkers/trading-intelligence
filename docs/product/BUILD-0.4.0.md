# Build 0.4.0 — Market Intelligence Meets Paper Trading

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.1.0.md`](./BUILD-0.1.0.md), [`BUILD-0.1.1.md`](./BUILD-0.1.1.md),
[`BUILD-0.2.0.md`](./BUILD-0.2.0.md), [`BUILD-0.3.0.md`](./BUILD-0.3.0.md)

## What was built

This build connects the Market Intelligence page (Build 0.3.0) to the existing paper trading
workflow (Build 0.2.0), so a user can review the evidence for an opportunity, understand what
could invalidate it, and — only then — place a paper trade from the same page. The philosophy is
unchanged: **understand first, decide second, trade last**.

- **Paper Trade action on Market Intelligence.** The Recommendation panel for the selected
  opportunity now shows a "Paper Trade" button when the recommendation is **Strong Buy, Buy, or
  Strong Sell**. **Hold and Avoid recommendations are never tradeable** — even Tesla's SELL-signal
  opportunity, once its evidence was strong enough to earn a Strong Sell rating, required an
  explicit "Strong Sell" verdict before becoming actionable. This is a deliberate reading of "never
  encourage impulsive trading": a moderate, non-committal call should never carry a one-click
  trade button.
- **One paper trade system, two entry points.** The existing risk warning modal
  (`PaperTradeModal`) and the existing `PaperTradesProvider` context are reused as-is — no second
  trade system was built. The modal gained one small, optional addition: a "Source" line, shown
  only when a trade originates from Market Intelligence, so the confirmation dialog is honest
  about where the idea came from without changing anything for the existing Signals flow.
- **Evidence now travels with the trade.** Trades placed from Market Intelligence carry their
  originating recommendation, star-rating evidence, "why" bullets, and "what could change" bullets
  onto the `PaperTrade` record itself (see Type changes below). Trades placed from Signals are
  unaffected and continue to work exactly as before.
- **Trade Journal shows provenance.** Every trade now displays a Source badge — **Signal** or
  **Market Intelligence**. Market Intelligence trades additionally render a distinct context block
  with their recommendation, evidence bullets, and invalidation bullets, directly on the journal
  entry. Signal-sourced trades render a plain, compact card with no extra block, so information
  density matches what's actually available — the UI stays clean rather than padding out Signal
  trades with empty sections.
- **Trade Journal filtering.** Five simple filter buttons — All, Signals, Market Intelligence,
  BUY, SELL — using local component state only, no persistence needed.
- **Paper Portfolio shows source too.** The "Recent paper trades" table on the Portfolio page
  gained a Source column, so provenance is visible at a glance without leaving the page.

## Type / model changes

- `PaperTrade` gained:
  - `source: "Signal" | "Market Intelligence"` (new, required going forward)
  - `sourceOpportunityId?: string` (parallel to the existing `sourceSignalId?: string`)
  - `intelligence?: { recommendation, evidence, evidenceFactors, invalidationFactors }` — only
    present on Market Intelligence trades
- **Backward compatibility:** trades saved before this build have no `source` field on disk. The
  `PaperTradesProvider` normalizes any record missing `source` to `"Signal"` at load time (the
  only flow that existed before this build), then persists the upgraded shape back to
  `localStorage`. This was tested directly against a hand-seeded legacy-format record and confirmed
  correct.
- New helpers in `src/lib/utils/paper-trade.ts`: `buildPaperTradeFromOpportunity`,
  `isTradeableRecommendation` (Hold/Avoid excluded), alongside the existing
  `buildPaperTradeFromSignal` and `isTradeableSignal`, which are unchanged in behaviour.
- `PaperTradesProvider` gained `hasTradeForOpportunity(id)`, mirroring the existing
  `hasTradeForSignal(id)`, so a Market Intelligence opportunity that's already been traded shows a
  "Trade placed" badge instead of a duplicate action, exactly like the Signals page.

## Other changes worth noting

- **Fixed a ranking bug**: the Opportunities list was labelled "Ranked by confidence" but simply
  reflected mock-data declaration order, which was not actually sorted (Tesla at 67% appeared below
  the S&P 500 ETF at 65%). Opportunities are now sorted by `confidencePercent` descending in
  `MarketIntelligenceView`, so the ranking claim is actually true regardless of how the mock data
  is declared in future.
- **Tesla's mock recommendation was changed from "Avoid" to "Strong Sell"** (with correspondingly
  stronger bearish evidence and confidence raised from 67% to 74%), specifically so the SELL-side
  paper trade path has a real, end-to-end demonstrable example. This is a disclosed content change
  to Build 0.3.0's mock data, not a silent one.
- **`PaperTradesTable` was simplified**, not duplicated: it gained a Source column and dropped its
  now-unused `compact` toggle and the columns that only existed for the old, non-compact Trade
  Journal table (Confidence/Strategy/Reason), since Trade Journal now uses the richer
  `TradeJournalList` card view instead. `PaperTradesTable` remains the single component behind the
  Portfolio page's "Recent paper trades" section.

## What is intentionally not included yet

- No trade closing, position netting, or simulated P/L movement on open paper trades (unchanged).
- No persistence of Trade Journal filter selection across reloads (by design — local state only,
  per the brief).
- No real market data, technical indicators, or model-generated scoring (unchanged).
- Unchanged from prior builds: no authentication, no database, no real broker connection, no live
  execution, no financial advice language.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open `http://localhost:3000/market-intelligence`, select an opportunity with a Strong Buy, Buy, or
Strong Sell rating, and use "Paper Trade" in the Recommendation panel. `npm run lint` and
`npm run build` both pass cleanly. Manually verified in this build: existing Signals-page paper
trades still work unchanged; new Market Intelligence paper trades work for both BUY and SELL;
Trade Journal correctly displays and filters both trade sources; and `localStorage` persistence,
including migration of pre-existing trade records, continues to work correctly.

## Next recommended build

**Build 0.5.0**: introduce a database (Supabase) behind the existing type contracts in
`src/lib/types`, moving paper trades from `localStorage` into real persistence so history survives
across devices — the `source`, `intelligence`, and legacy-normalization logic added in this build
should map directly onto database columns/JSON fields with minimal rework. Trade closing and
realized P/L remain the recommended follow-up after that.
