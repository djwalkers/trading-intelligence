# Build 0.8.0 — Intelligence Score

Date: 2026-07-07
Location: `Trading/platform/web`
Related: [`BUILD-0.7.0.md`](./BUILD-0.7.0.md)

## What was built

Market Intelligence could already tell you *what* to do about one opportunity at a time. This
build adds the ability to *compare* — a 0–100 Intelligence Score for every opportunity, a plain-
English explanation of why that score is what it is, a side-by-side comparison of up to three
opportunities, and roll-up summaries on the Watchlist and Dashboard. The philosophy is unchanged:
**understand first, decide second, trade last** — the score and its explanation exist to help you
understand and compare, not to hand you a decision.

- **Intelligence Score on Market Intelligence.** Each opportunity now has an Overall Intelligence
  Score (0–100) plus seven underlying factors: Trend, Momentum, Volume, Volatility, Market
  Context, Risk, and Reward. All seven are on the same "higher is better" scale — including Risk
  and Volatility, which represent favourability (low actual risk/volatility scores high), so
  they can be averaged and compared without sign-flipping logic scattered through the UI. The
  overall score is a fixed, disclosed weighted average (Trend 20%, Momentum 20%, Market Context
  15%, Reward 15%, Volume 10%, Volatility 10%, Risk 10%) — mock and deterministic, not AI, not
  live data.
- **Explain Score.** For the selected opportunity: a templated, rule-based sentence explaining why
  the score is high or low, a list of factors that increased confidence (score ≥ 70), and a list
  of factors that reduced it (score < 50). Entirely generated from thresholds and string
  templates — no AI wording, no model, same output every time for the same inputs.
- **Comparison feature.** Every opportunity in the ranked list has a checkbox; ticking up to three
  reveals a "Compare opportunities" table (Instrument, Signal, Overall, Trend, Momentum, Volume,
  Volatility, Risk, Reward, Recommendation) further down the page.
- **Watchlist Health.** A new summary panel on the Watchlist page: Excellent (80+), Good (65–79),
  Weak (50–64), and Avoid/monitor only (below 50) opportunity counts.
- **Dashboard Intelligence Summary.** A compact card: highest-scoring opportunity, average score
  across all opportunities, and counts of Excellent and monitor-only opportunities.

## Design discipline

No gauges, no neon, no per-factor colour-coding, no gambling-style visual language. The seven-
factor breakdown is a plain monochrome bar (same fill colour regardless of value) next to its raw
number — the bar communicates magnitude, the number is the source of truth. Colour is reserved
for the two score-band extremes (Excellent = teal, Avoid = amber), exactly matching the existing
`recommendationClasses` pattern from Market Intelligence — Good and Weak stay neutral, so
comparison happens through the numbers and layout, not a traffic light.

## Type / model changes

- `Opportunity` gained `intelligenceFactors: IntelligenceFactorScores`.
- New types in `src/lib/types/market-intelligence.ts`: `IntelligenceFactorScores` (seven 0–100
  numbers) and `ScoreBand` (`"Excellent" | "Good" | "Weak" | "Avoid"`).
- No changes to `PaperTrade` or any other existing type — this build is additive to the Market
  Intelligence domain only.

## New architecture

- `src/lib/utils/intelligence-score.ts` — the calculation layer, kept separate from every
  component: `calculateOverallIntelligenceScore`, `getScoreBand`, `explainIntelligenceScore`, and
  `summarizeIntelligenceScores` (shared by both Watchlist Health and the Dashboard summary — one
  calculation, two presentations tailored to what each page actually needs).
- Reusable components: `IntelligenceScoreDisplay` (compact/full variant), `IntelligenceScoreBreakdown`
  (the seven-factor bars), `ScoreExplanation`, `ComparisonTable`, and `WatchlistHealthSummary`
  (new `src/components/watchlist/` folder, matching the existing `components/dashboard/`
  convention) plus `IntelligenceSummaryCard` in `components/dashboard/`.
- `OpportunityList` was restructured from an all-in-one `<button>` row to a `<div>` row containing
  a standalone compare checkbox and a nested `<button>` for the existing "select for detail"
  behaviour — nesting a checkbox inside a button is invalid HTML and would have conflated two
  independent selection states (single-select detail view vs. multi-select comparison).

## Fixed while touching this code

The build-number labels on the sidebar footer, app footer, and System Health page were still
showing "Build 0.7.0" — bumped to "Build 0.8.0" alongside everything else, consistent with every
prior build's practice of not leaving stale version labels behind.

## What is intentionally not included yet

- No persistence of Intelligence Scores or comparisons — they're derived from mock data on every
  render, same as the rest of Market Intelligence.
- No "Paper Trade" action wired to the comparison table — trading still happens from the existing
  Recommendation panel for the single selected opportunity.
- No real market data, technical indicators, or model-generated scoring (unchanged).
- Everything else unchanged from Build 0.7.0: local storage only, no Supabase connection, no
  authentication, no broker connection, no live trading, no AI, no financial advice language.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

Open `/market-intelligence`, select an opportunity to see its Intelligence Score and Explain
Score, and tick two or three checkboxes in the Opportunities list to see the comparison table.
`npm run lint` and `npm run build` both pass cleanly. Manually verified in this build: existing
paper trading (both Signal and Market Intelligence sourced), trade closing, and Trade Journal all
continue to work unchanged; Watchlist and Dashboard load correctly with their new panels; and the
comparison feature correctly caps at three selections.

## Next recommended build

**Build 0.9.0**: implement `SupabasePaperTradeStore` for real against the schema from Build 0.7.0
— add `@supabase/supabase-js`, wire up the three tables, add a one-time localStorage import step,
and flip `getPaperTradeStore()` to select it when configured. Once real persistence exists, storing
a snapshot of each trade's Intelligence Score at open time (not just at render time) becomes
possible, which would let the Trade Journal show "the score when I opened this" versus "the score
now" — a natural follow-up once the underlying scores are no longer purely mock and static.
