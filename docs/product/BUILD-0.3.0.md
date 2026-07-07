# Build 0.3.0 — Market Intelligence

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.1.0.md`](./BUILD-0.1.0.md), [`BUILD-0.1.1.md`](./BUILD-0.1.1.md),
[`BUILD-0.2.0.md`](./BUILD-0.2.0.md)

## Philosophy

This build's purpose is to make the platform feel like an intelligent assistant rather than a
dashboard of numbers. Every recommendation on the new Market Intelligence page follows the same
sequence: **understand first, decide second, trade last** — and every recommendation explains
both why it was made and what would change it. Nothing here encourages impulsive trading; the
page is deliberately built around evidence and transparency rather than urgency.

## What was built

A new flagship page, **Market Intelligence**, added to the main navigation directly below
Dashboard.

- **Market Overview** — market status (reusing the existing mocked market status data), overall
  market regime (Bullish/Neutral/Bearish), market confidence (0–100%), volatility
  (Low/Medium/High), and risk environment (Low/Moderate/Elevated).
- **Opportunities** — a ranked list of five mock opportunities (Microsoft, Nvidia, Apple, S&P 500
  ETF, Tesla), each showing instrument, BUY/SELL/HOLD, confidence, and a short reason. Ranked by
  confidence, highest first. Selecting one updates every section below it.
- **Decision Breakdown** — five-factor evidence rating (Trend, Momentum, Volume, Volatility,
  Market Direction) shown as a star rating out of 5, plus an overall rating.
- **Recommendation** — one of Strong Buy / Buy / Hold / Avoid / Strong Sell, with a plain-language
  paragraph explaining the reasoning in the voice of an analytical engine — no AI-style phrasing.
- **Why this recommendation?** — 4–6 concrete evidence points behind the call.
- **What could change?** — 4–6 concrete factors that would invalidate the recommendation. This
  section is treated as equally important as the recommendation itself, reinforcing that every
  view is conditional and evidence-based, not a promise.

## Design decisions

- **Restrained colour, layout-driven confidence.** Colour is reserved for the two extremes only
  (Strong Buy / Strong Sell); Buy, Hold, and Avoid render in neutral tones. Star ratings are
  monochrome (filled vs. unfilled), not red/green. Confidence and conviction come through
  typography, position, and the amount of supporting evidence shown — not colour intensity.
- **No flashy graphics.** No gauges, animated meters, or charts were added — evidence is presented
  as plain ratings, badges, and prose, consistent with the platform's calm, evidence-driven tone.
- **Reused, not duplicated, existing data.** Market status on this page reads from the same mocked
  `marketStatus` object already used on the Dashboard, Topbar, and System Health page, rather than
  introducing a second source of truth.

## Architecture

- New types in `src/lib/types/market-intelligence.ts` (`MarketOverview`, `Opportunity`,
  `Recommendation`, `EvidenceRating`, and the supporting `MarketRegime` / `VolatilityLevel` /
  `RiskLevel` unions), exported through the existing `src/lib/types/index.ts` barrel.
- New mock data in `src/lib/mock/market-intelligence.ts`, exported through the existing
  `src/lib/mock/index.ts` barrel — mock data stays fully separate from UI, matching the pattern
  established in Build 0.1.0.
- New restrained-colour style helpers (`recommendationClasses`, `marketRegimeClasses`,
  `volatilityClasses`, `riskLevelClasses`) added to the existing `src/lib/utils/style.ts`.
- New reusable components in `src/components/market-intelligence/`: `MarketOverviewPanel`,
  `OpportunityList`, `DecisionBreakdownPanel`, `RecommendationPanel`, and `EvidenceBulletList` — the
  last of these is a single reusable component parameterised by title/tone, used for both "Why
  this recommendation?" and "What could change?" rather than writing two near-identical
  components.
- New `StarRating` primitive in `src/components/ui/`, reusable anywhere a 0–5 rating is needed.
- The page itself (`src/app/market-intelligence/page.tsx`) is a server component that passes mock
  data as props into a client view (`MarketIntelligenceView`), matching the server/client split
  already used by the Paper Portfolio and Trade Journal pages.

## What is intentionally not included yet

- No real market data, technical indicators, or model-generated scoring — evidence ratings and
  recommendations are mock data.
- No link between Market Intelligence and the paper trading flow (opportunities are not yet
  "Paper Trade"-able from this page).
- No persistence of the selected opportunity across page reloads.
- Unchanged from prior builds: no authentication, no database, no real broker connection, no
  live execution, no financial advice language.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open `http://localhost:3000/market-intelligence`. `npm run lint` and `npm run build` both pass
cleanly on this build, and every existing page (Dashboard, Watchlist, Signals, Paper Portfolio,
Trade Journal, Strategies, System Health) continues to work exactly as before.

## Next recommended build

**Build 0.4.0**: connect Market Intelligence to the paper trading flow — let a user place a paper
trade directly from an opportunity's Decision Breakdown, carrying the recommendation's evidence
and rating onto the resulting trade (extending the existing `PaperTrade` type rather than
replacing it).
