# Mission 2 — Portfolio Risk Manager v1

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`MISSION-1.1-BOT-CANDIDATE-FALLBACK.md`](./MISSION-1.1-BOT-CANDIDATE-FALLBACK.md),
[`MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md`](./MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md)

## What was built

The Bot Runner now evaluates whether a new trade is appropriate for the *whole paper portfolio*,
not just whether the individual opportunity clears its own bar. A new Portfolio Risk Manager
computes the portfolio's current exposure — open trade count, capital deployed, available cash,
and exposure by instrument/side/sector — and checks six hardcoded portfolio-level rules before the
bot is allowed to open a trade. A candidate that passes every individual check can still be
rejected here; when that happens, the bot falls back to the next-ranked candidate exactly as it
already did for individual risk failures (Mission 1.1). **Still no live trading, no broker API, no
AI, no Hermes — paper trading only.**

- **Portfolio Risk Manager** (`src/lib/bot/portfolio-risk.ts`): `buildExposureSnapshot(trades)`
  computes a point-in-time snapshot (total open trades, total capital deployed, available cash,
  exposure by instrument, by side, and by sector); `evaluatePortfolioRisk(snapshot, symbol, side,
  notional)` checks six hardcoded rules against what the portfolio would look like *after* adding
  one more candidate trade.
- **Mock sector data** (`src/lib/mock/sectors.ts`): a simple symbol → sector lookup (Apple/
  Microsoft/Nvidia → Technology, Tesla → Consumer Discretionary, S&P 500 ETF → Broad Market ETF),
  kept out of the `Instrument` type and every UI component — only the Portfolio Risk Manager reads
  it.
- **Two-tier risk evaluation in the Bot Runner**: for each ranked candidate, individual risk checks
  (Mission 1/1.1, unchanged) run first; only if all five pass does the Portfolio Risk Manager
  evaluate the six portfolio rules. If either tier fails, the bot falls back to the next-ranked
  candidate — the loop and "at most one trade per scan" guarantee from Mission 1.1 are unchanged.
- **Decision trace** gained a "Portfolio snapshot captured" step at scan start and a "Portfolio
  risk evaluated" step per candidate that reaches that tier; candidate rejection reasons now
  distinguish "individual checks failed" from "individual checks passed; portfolio risk failed:
  <which checks, why>".
- **Bot Decisions page** now shows, per scan, a collapsible "Portfolio exposure at scan time"
  section (open trades, capital deployed, available cash, exposure by side and sector), and per
  candidate, two separate labelled check lists — "Individual risk checks" and "Portfolio risk
  checks" (the latter replaced by "Portfolio risk not evaluated — individual checks failed first"
  when individual checks already failed).
- **Dashboard Bot Runner panel** shows each candidate's individual/portfolio status distinctly
  (e.g. "Individual: Passed · Portfolio: Failed") alongside its rejection reason.
- **System Health** gained four new rows on the Bot Runner panel: Portfolio Risk Manager (Active),
  Open trade limit, Capital deployment limit, and Sector exposure limit — all reading the same
  hardcoded constants the risk manager itself enforces, so they can never drift out of sync.
- **Trade metadata**: Bot-sourced trades now also record `portfolioRiskStatus` ("Passed"),
  `portfolioRiskSummary` (one line per portfolio check), and `portfolioExposureSnapshot` (the full
  snapshot immediately before this trade was added).

## Architecture overview

```
runBotScan(instruments, trades, scanId)
  1. openTrades = trades.filter(status === "Open")            — for the individual duplicate check
  2. portfolioSnapshotBefore = buildExposureSnapshot(trades)   — ONE baseline for the whole scan
  3. rank tradeable candidates by confidence                    — unchanged from Mission 1/1.1
  4. for each candidate, in ranked order:
       evaluateCandidateRisk(...)             — 5 individual checks (Mission 1/1.1, unchanged)
       if any fail → reject, continue to next candidate
       evaluatePortfolioRisk(portfolioSnapshotBefore, symbol, side, notional)  — 6 portfolio checks
       if any fail → reject, continue to next candidate
       if both pass → buildBotTrade(...), break the loop
  5. if no candidate ever passed both tiers → "No Trade"
```

**Why one portfolio snapshot per scan, not one per candidate:** at most one trade is ever opened
per scan (the loop breaks the instant a candidate passes), so the portfolio's real exposure cannot
change mid-scan — every candidate in the same scan is legitimately evaluated against the same
baseline. Rebuilding the snapshot per candidate would be redundant work for an identical answer.

**Why portfolio risk is only evaluated after individual risk passes:** there's no point checking
whether the whole portfolio can absorb a trade that already fails on its own terms (e.g., below
minimum confidence). This mirrors the mission's own example exactly: "Individual checks passed" is
shown before "Portfolio risk failed," never the reverse.

**Why sector data lives in `src/lib/mock/sectors.ts`, not on the `Instrument` type:** the mission
asked to keep this data "separate from UI components." Going further and keeping it out of the
shared `Instrument` interface too avoids widening a type that Watchlist, Signals, and Market
Intelligence all already depend on for an addition only the Portfolio Risk Manager currently needs
— a plain lookup function (`getSectorForSymbol`) is the entire interface.

**Why `PortfolioExposureSnapshot` lives in `@/lib/types/portfolio-risk.ts`, not in
`src/lib/bot/`:** `PaperTrade` (a core, broadly-shared type) needs to reference this shape for its
new `portfolioExposureSnapshot` field. Defining the snapshot type inside the bot feature module
would mean `@/lib/types` depending on `@/lib/bot` — backwards, since types should never depend on a
feature module built on top of them. Keeping the snapshot shape in `@/lib/types` (barrel-exported,
since it doesn't collide with anything) means both `PaperTrade` and `src/lib/bot/portfolio-risk.ts`
import it from the same, correctly-directioned place.

**Why percent-based limits are measured against *starting* paper capital, not current portfolio
value:** `paperPortfolio.startingValue` (£10,000) is a fixed number that never moves. Measuring
against current portfolio value would make the 60%/30% ceilings themselves drift as trades open,
close, and realise P/L — a moving target that would make the risk rules harder to reason about, not
easier. This is a deliberate v1 simplification, disclosed below.

**Why available cash reuses `PortfolioView`'s exact formula:** `paperPortfolio.cashBalance -
totalCapitalDeployed(open trades) + realisedPnl(closed trades)` is already how the Paper Portfolio
page computes "Cash balance" for a human. The Portfolio Risk Manager reuses it verbatim rather than
inventing a second, subtly different notion of available cash that could disagree with what a human
sees on that page.

## Portfolio risk rules implemented

All six evaluate what the portfolio would look like *after* adding the candidate's prospective
trade, and — like the five individual checks before them — every check always runs and is always
recorded, whether it passed or not:

| # | Rule | Enforced as |
|---|------|-------------|
| 1 | Maximum 5 open trades | `existing open trades + 1 <= 5` |
| 2 | Maximum 60% of starting paper capital deployed | `existing capital deployed + candidate notional <= 60% × £10,000` |
| 3 | Maximum 30% exposure to one sector/category | `existing sector capital + candidate notional <= 30% × £10,000` |
| 4 | Maximum 3 open trades in one sector/category | `existing open trades in that sector + 1 <= 3` |
| 5 | Minimum £1,000 paper cash remaining after the trade | `available cash − candidate notional >= £1,000` |
| 6 | No more than 4 open trades in the same direction | `existing open trades on that side + 1 <= 4` |

**No individual risk rule was weakened, removed, or made conditional.** The five rules from
Mission 1/1.1 (max one trade per scan, no duplicate, minimum 75% confidence, no Conflict agreement,
£250 max notional) run first, completely unchanged, and a candidate must still pass every one of
them before the Portfolio Risk Manager is even consulted.

## Files changed

New:
- `src/lib/types/portfolio-risk.ts` — `PortfolioExposureSnapshot` (barrel-exported)
- `src/lib/mock/sectors.ts` — `getSectorForSymbol()`
- `src/lib/bot/portfolio-risk.ts` — `buildExposureSnapshot()`, `evaluatePortfolioRisk()`, the six
  hardcoded limit constants
- `supabase/migrations/0012_portfolio_risk_manager.sql`

Changed:
- `src/lib/types/paper-trade.ts` — three new optional fields: `portfolioRiskStatus`,
  `portfolioRiskSummary`, `portfolioExposureSnapshot`
- `src/lib/types/index.ts` — barrel-exports `portfolio-risk.ts`
- `src/lib/bot/types.ts` — `BotCandidateEvaluation` splits `riskChecks` into
  `individualRiskChecks`/`individualPassed` and `portfolioRiskChecks`/`portfolioRiskEvaluated`/
  `portfolioPassed`; `BotDecision` gains `portfolioSnapshotBefore`
- `src/lib/bot/bot-runner.ts` — takes `trades` (not just `openTrades`) so it can compute realised
  P/L for the cash calculation; two-tier risk evaluation per candidate
- `src/lib/bot/index.ts` — barrel exports the new module and types
- `src/lib/persistence/supabase-paper-trade-store.ts` — maps the three new columns both ways
- `src/lib/state/bot-decision-log-context.tsx` — storage key bumped to `v3`
- `src/components/dashboard/BotRunnerPanel.tsx` — passes `trades`; shows per-candidate
  individual/portfolio status
- `src/components/bot/BotDecisionsView.tsx` — portfolio exposure snapshot section; separate
  individual/portfolio risk check lists per candidate
- `src/components/system-health/BotRunnerStatusPanel.tsx` — four new Portfolio Risk Manager rows
- `src/components/trading/TradeJournalEntry.tsx` — shows `Portfolio risk: Passed` and the
  portfolio checks summary when present
- `src/components/layout/Sidebar.tsx`, `Footer.tsx`, `src/app/system-health/page.tsx` — build
  label bumped to "Mission 2"

## Database changes

**`0012_portfolio_risk_manager.sql`** — adds three nullable columns to `paper_trades`:
`portfolio_risk_status` (text, checked against `'Passed'`/`'Failed'`), `portfolio_risk_summary`
(text), and `portfolio_exposure_snapshot` (jsonb). All purely informational, never read by any P/L
calculation — every trade placed before this migration is unaffected.

## Manual Supabase steps required

Run `0012_portfolio_risk_manager.sql` in the SQL Editor (same anon-key-only limitation as every
schema change in this project). Migrations `0008`–`0011` remain unapplied from prior builds/
missions — the verification debt is now six migrations deep.

## Test scenarios verified

**Verified in local prototype mode**, using a deliberately seeded portfolio (three pre-existing
open Technology trades — two AAPL, one MSFT, all BUY, small quantities) injected directly into
`localStorage` to exercise the portfolio rules without needing dozens of real scans:

- **Portfolio risk correctly rejects a candidate that passes every individual check.** With 3 open
  Technology trades already on the books, NVDA (Technology, the top-ranked candidate at 82%
  confidence) passed all 5 individual checks but failed "Max open trades per sector" (a 4th
  Technology trade would exceed the 3-trade sector limit) — exactly the scenario the mission's own
  example describes.
- **The bot correctly fell back to the next candidate.** TSLA (Consumer Discretionary, 78%
  confidence) was then evaluated, passed all 5 individual checks and all 6 portfolio checks, and
  opened — confirming both "falls back to next candidate on portfolio failure" and "still opens a
  trade when portfolio risk passes," in the same scan.
- **A second scan correctly opened no trade at all.** With TSLA now also open (4 open BUY trades
  total), NVDA still failed on sector count and additionally on "Max same-direction trades" (a 5th
  BUY would exceed the 4-trade limit); TSLA — now itself a duplicate open position — failed on the
  individual "No duplicate open trade" check instead. Every candidate failed (a mix of individual
  and portfolio reasons), and the bot correctly opened nothing, reporting "All 2 candidate(s) failed
  individual or portfolio risk checks."
- **The duplicate-trade rule (Mission 1) still works** — confirmed directly above (TSLA's second
  rejection).
- The Bot Decisions page correctly showed, for the first scan: an accurate "Portfolio exposure at
  scan time" snapshot (3 open trades, £867.90 deployed, £2,382.10 available cash, 3 Technology
  trades), NVDA's individual checks all "Passed" with its portfolio checks correctly showing only
  "Max open trades per sector" as "Failed" (all five other portfolio numbers matched hand
  calculations exactly — e.g. £1,006.55 deployed after, £2,243.45 cash remaining after), and TSLA's
  both tiers fully "Passed".
- System Health's Bot Runner panel correctly showed "Portfolio Risk Manager: Active", "Open trade
  limit: 5 open trades", "Capital deployment limit: 60% of starting capital", and "Sector exposure
  limit: 30% · max 3 trades/sector".
- Trade Journal correctly displayed `Portfolio risk: Passed` and the full six-check portfolio
  summary on the TSLA trade opened via fallback.
- Existing Signal-sourced and Market-Intelligence-sourced trades were both placed successfully in
  the same session — all trade sources (seeded Signal trades, Bot, Signal, Market Intelligence)
  coexisted correctly in Trade Journal with no regressions.
- `npm run lint` and `npm run build` both pass cleanly.
- Restoring `.env.local` and reloading in Supabase-configured mode still correctly gates behind
  sign-in with no console errors — no regression from this mission's changes.

**Not verified against a real authenticated Supabase session:** migration `0012` has not been
applied to the live project, and (per the limitation disclosed in every prior build/mission) no
confirmable test account was available in this environment, so a Bot-sourced trade's portfolio risk
metadata persisting to Supabase end-to-end was not exercised.

**A disclosed interaction worth noting:** given this prototype's fixed mock `cashBalance` (£3,250)
and the £1,000 minimum-cash-remaining rule, the effective deployable ceiling before cash binds
(~£2,250) is actually tighter than the 30% sector-exposure ceiling (£3,000) or the 60% total-capital
ceiling (£6,000) for any single additional small trade. In practice, with this mock dataset's price
levels, the cash-remaining rule tends to bind before the capital or sector *exposure* percentage
rules do — the sector *open-trade-count* rule (max 3) is what this verification used to isolate a
clean, count-based portfolio rejection independent of cash. All six rules are implemented and
enforced identically; this is an observation about which one is easiest to trigger first with this
specific mock data, not a defect.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. `npm run lint` and `npm run build` both pass cleanly.

## Suggested next mission

The verification debt is now six migrations deep (`0008`–`0012`, plus confirming a real test
account) — still the standing top priority independent of any new mission. Beyond that: a richer
mock instrument/sector universe (more than 5 instruments, more than 3 sectors) would let future
verification isolate each portfolio rule in full independence rather than the cash/sector-count
interaction noted above; scheduled or interval-based bot triggering now that manual triggering,
candidate fallback, and portfolio risk are all proven; or extending the Portfolio Risk Manager with
correlation-aware limits (today, "sector" is the only cross-instrument grouping considered).
