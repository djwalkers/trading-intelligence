import type { StrategyDefinitionDocument } from "../strategy-definitions/strategy-definition";
import type { Candle } from "../types";
import { computeIndicatorSeries, evaluateRuleNode } from "./rule-evaluator";

// Phase 2 — Deterministic Backtesting Foundation. Long-only, one-position, next-bar-execution
// simulation engine — no broker/execution/approval/lifecycle/risk import, no network call, no
// randomness anywhere (every loop is a plain deterministic bar-by-bar walk). Never wired into any
// live runtime path; the only inputs are an already-validated StrategyDefinitionDocument (Phase 1)
// and an already-validated local candle array (backtest-dataset.ts) — this module itself performs
// no I/O at all.
//
// Pre-commit review fix: BACKTEST_ENGINE_VERSION bumped 1 -> 2. Two behavioural corrections change
// computed results for otherwise-unchanged inputs: (1) entry sizing now reserves cash for the entry
// fee up front (previously it could commit slightly more than available capital — see
// `sizePosition`'s own doc comment), and (2) max drawdown is now computed from a bar-by-bar,
// mark-to-market equity curve rather than only at trade closes (previously blind to an intra-trade
// drawdown that had recovered by the time the trade closed). A run fingerprinted under version 1 is
// NEVER claimed reproducible against version 2 — `computeRunFingerprint` includes this constant
// precisely so the two are never confused.
export const BACKTEST_ENGINE_VERSION = 2;

/** Fixed engine policy for this version: every entry invests the ENTIRE current cash balance into
 * one position — there is no partial allocation, and this is never configurable, and never read
 * from the strategy document itself (Phase 1's own prohibited-field scanner already rejects any
 * sizing-shaped field in a strategy JSON — `orderSize`/`positionSize`/`quantity`/`notional`/etc. —
 * so a strategy document could never smuggle a sizing override in even if this constant didn't
 * exist). A future engine version may add a genuinely configurable `BacktestConfig.allocationFraction`
 * as a new, explicit field — it will never be inferred from strategy content. */
export const FULL_CAPITAL_ALLOCATION_FRACTION = 1;

export interface BacktestCostConfig {
  /** Fixed fee, in basis points of notional, applied on BOTH entry and exit. Must be finite and
   * >= 0 — see `validateCostConfig`. */
  feeBps: number;
  /** Slippage, in basis points, applied against the executed price: entry pays worse (higher) than
   * the raw open, exit receives worse (lower) than the raw open — always a cost, never a benefit,
   * since this engine never assumes favourable fills. Must be finite, >= 0, and strictly less than
   * 10,000 (100%) — see `validateCostConfig`'s own doc comment for why 100%+ is rejected outright
   * rather than merely "very large but valid." */
  slippageBps: number;
}

export interface BacktestConfig extends BacktestCostConfig {
  startingCapital: number;
}

export type TradeExitReason = "SIGNAL" | "MAX_BARS_HELD" | "END_OF_DATA";

export interface BacktestTrade {
  entryBarIndex: number;
  entryTimestamp: string;
  entryPriceRaw: number;
  entryPriceExecuted: number;
  exitBarIndex: number;
  exitTimestamp: string;
  exitPriceRaw: number;
  exitPriceExecuted: number;
  /** `"END_OF_DATA"` is a RESEARCH CONVENTION, never a signal the strategy itself generated — the
   * dataset simply ran out while a position was still open, so this engine closes it at the last
   * available price purely to make the run's metrics computable at all. It is never evidence the
   * strategy "would have" exited there in reality; see `BacktestResult.warnings` for the explicit,
   * per-run flag this produces (`runBacktest` in backtest-result.ts). */
  exitReason: TradeExitReason;
  quantity: number;
  barsHeld: number;
  /** (exitPriceRaw - entryPriceRaw) * quantity — the market's own move, before any cost. */
  grossPnl: number;
  /** (exitPriceExecuted - entryPriceExecuted) * quantity - feesPaid — what actually happened to
   * capital, after slippage AND fees. `netPnl` summed across every trade, added to
   * `startingCapital`, always equals `endingCapital` exactly (see `computeSegmentMetrics`). */
  netPnl: number;
  feesPaid: number;
  slippageCost: number;
}

export interface BacktestSegmentMetrics {
  barCount: number;
  startTimestamp: string;
  endTimestamp: string;
  startingCapital: number;
  endingCapital: number;
  totalReturn: number;
  grossPnl: number;
  netPnl: number;
  totalFees: number;
  totalSlippageCost: number;
  tradeCount: number;
  /** Fraction of trades with `netPnl > 0` (NET, after fees and slippage — never gross) — a trade
   * that made money on raw price movement but lost money once costs are applied is NOT a winner
   * here. */
  winRate: number;
  /** Positive fraction (e.g. 0.15 for a 15% peak-to-trough decline), computed from a bar-by-bar,
   * MARKED-TO-MARKET equity curve: cash plus the current unrealised value of any open position,
   * valued at each bar's own close price (never assuming the slippage/fees a real close would
   * incur) — not merely the equity implied by closed-trade P&L alone, which would be blind to an
   * intra-trade drawdown that had already recovered by the time the position closed. 0 when the
   * curve never declines from its own running peak. */
  maxDrawdown: number;
  averageTrade: number;
  /** sum(winning netPnl) / abs(sum(losing netPnl)) — same NET basis as `winRate`. `null` when there
   * are no losing trades at all (covers both "zero trades" and "every trade won") — never reported
   * as `Infinity` (not JSON-representable); see `computeSegmentMetrics`'s own doc comment. */
  profitFactor: number | null;
  /** Percentage of bars during which a position was open, counted from the bar an entry executes
   * (inclusive) to the bar an exit executes (exclusive) — i.e. the exit bar itself is counted as
   * flat, since the position closed at that bar's own open. */
  exposurePercentage: number;
  trades: BacktestTrade[];
}

export interface CostConfigError {
  ok: false;
  detail: string;
}

// A sell execution price is `rawPrice * (1 - slippageRate)` — at slippageRate >= 1 (slippageBps >=
// 10,000, i.e. 100%+) this would be zero or negative, which can never be a real execution price.
// Rejected outright here rather than merely documented as "an extreme but valid value," per the
// pre-commit review's own "very high but valid costs cannot produce invalid quantities or negative
// execution prices" requirement.
const MAX_SLIPPAGE_BPS = 10_000;

/** Fees/slippage must be finite and non-negative — a negative value would mean "the market pays
 * you to trade," which this engine never models, and a non-finite value can never represent a real
 * basis-point rate. `slippageBps` is additionally capped strictly below `MAX_SLIPPAGE_BPS` (100%) —
 * see that constant's own doc comment. `feeBps` has no comparable upper bound: however large, it
 * only ever scales notional (a plain positive multiplication), never inverts an execution price's
 * sign the way unbounded slippage can. Rejected explicitly, never clamped or silently defaulted. */
export function validateCostConfig(config: BacktestCostConfig): { ok: true } | CostConfigError {
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0) {
    return { ok: false, detail: `feeBps must be a finite number >= 0 (got ${JSON.stringify(config.feeBps)})` };
  }
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0) {
    return { ok: false, detail: `slippageBps must be a finite number >= 0 (got ${JSON.stringify(config.slippageBps)})` };
  }
  if (config.slippageBps >= MAX_SLIPPAGE_BPS) {
    return { ok: false, detail: `slippageBps must be strictly less than ${MAX_SLIPPAGE_BPS} (100%) — at or above that, a sell would execute at a zero or negative price (got ${config.slippageBps})` };
  }
  return { ok: true };
}

interface OpenPosition {
  entryBarIndex: number;
  entryTimestamp: string;
  entryPriceRaw: number;
  entryPriceExecuted: number;
  quantity: number;
  entryFee: number;
}

/**
 * Sizes a new long entry so that notional PLUS the entry fee never exceeds `cash` — solving
 * `quantity * entryPriceExecuted * (1 + feeRate) = cash` for `quantity`, rather than the simpler
 * (and WRONG) `cash / entryPriceExecuted`, which spends the fee on top of an already-fully-invested
 * notional and can commit more than `cash` actually available (a form of implicit, unintended
 * leverage — the exact defect this pre-commit review fixed). `feeRate >= 0` always (enforced by
 * `validateCostConfig`), so this can never divide by zero or produce a negative/non-finite quantity.
 */
function sizePosition(cash: number, entryPriceExecuted: number, feeRate: number): { quantity: number; entryFee: number } {
  const investable = cash * FULL_CAPITAL_ALLOCATION_FRACTION;
  const quantity = investable / (entryPriceExecuted * (1 + feeRate));
  const entryFee = entryPriceExecuted * quantity * feeRate;
  return { quantity, entryFee };
}

/** Closes `position` at `exitPriceRaw`, applying slippage/fees exactly once each — the single
 * shared implementation for both a normal (signal/MAX_BARS_HELD) exit and the end-of-data fallback,
 * so the two paths can never independently drift out of consistency the way a prior, duplicated
 * version of this logic once did (a double-counted entry fee in one branch only). Returns the
 * completed trade record and the resulting cash balance — `entryFee` was already deducted from cash
 * at entry time (see `sizePosition`'s own caller), so only `exitFee` applies here. */
function closeTrade(position: OpenPosition, cashBeforeExit: number, exitBarIndex: number, exitTimestamp: string, exitPriceRaw: number, exitReason: TradeExitReason, feeRate: number, slippageRate: number): { trade: BacktestTrade; cashAfterExit: number } {
  const exitPriceExecuted = exitPriceRaw * (1 - slippageRate);
  const notional = exitPriceExecuted * position.quantity;
  const exitFee = notional * feeRate;
  const grossPnl = (exitPriceRaw - position.entryPriceRaw) * position.quantity;
  const netPnl = (exitPriceExecuted - position.entryPriceExecuted) * position.quantity - position.entryFee - exitFee;
  const slippageCost = (position.entryPriceExecuted - position.entryPriceRaw) * position.quantity + (exitPriceRaw - exitPriceExecuted) * position.quantity;
  const cashAfterExit = cashBeforeExit - exitFee + (exitPriceExecuted - position.entryPriceExecuted) * position.quantity;
  return {
    trade: {
      entryBarIndex: position.entryBarIndex,
      entryTimestamp: position.entryTimestamp,
      entryPriceRaw: position.entryPriceRaw,
      entryPriceExecuted: position.entryPriceExecuted,
      exitBarIndex,
      exitTimestamp,
      exitPriceRaw,
      exitPriceExecuted,
      exitReason,
      quantity: position.quantity,
      barsHeld: exitBarIndex - position.entryBarIndex,
      grossPnl,
      netPnl,
      feesPaid: position.entryFee + exitFee,
      slippageCost,
    },
    cashAfterExit,
  };
}

/**
 * Runs one deterministic, long-only, one-position backtest over `candles` for `document`'s own
 * entry/exit rules. No look-ahead: signals are detected at bar `i` using only `candles[0..i]` (via
 * `computeIndicatorSeries`/`evaluateRuleNode`, both themselves causal — see rule-evaluator.ts's own
 * doc comment), and every order EXECUTES no earlier than the OPEN of bar `i + 1` — an entry or exit
 * signal on the very LAST bar of the segment can therefore never execute at all within this segment
 * (there is no bar after it to execute at); an entry signal is simply never actioned, and an OPEN
 * position instead falls through to the end-of-data close policy below.
 *
 * End-of-data policy (deterministic, always applied, always reported via `exitReason:
 * "END_OF_DATA"`): a position still open after the last bar is closed at that last bar's own CLOSE
 * price — never left open/unresolved, never assumed to close at some hypothetical future price. This
 * is explicitly a RESEARCH CONVENTION for making the run's metrics computable, never a claim that the
 * strategy itself generated an exit signal there (see `BacktestTrade.exitReason`'s own doc comment,
 * and `runBacktest`'s own warning when this occurs).
 *
 * One position per instrument, no pyramiding: a new entry signal is never actioned while a position
 * is already open — evaluated (so its own indicators/rules still ran deterministically) but
 * discarded. Long-only: every trade is an ordinary buy-then-sell; this engine has no concept of a
 * short position at all in this version. Position sizing is always 100% of current cash (see
 * `FULL_CAPITAL_ALLOCATION_FRACTION`) with the entry fee reserved up front (see `sizePosition`) —
 * notional plus fee can never exceed available cash, so cash can never go negative and this engine
 * never models implicit leverage.
 */
export function runBacktestSegment(document: StrategyDefinitionDocument, candles: readonly Candle[], config: BacktestConfig): BacktestSegmentMetrics {
  const series = computeIndicatorSeries(candles, document.indicators);
  const warmupBars = Math.max(0, document.backtestPolicy.warmupBars);
  const feeRate = config.feeBps / 10_000;
  const slippageRate = config.slippageBps / 10_000;

  const trades: BacktestTrade[] = [];
  let openPosition: OpenPosition | undefined;
  let cash = config.startingCapital;
  let barsInPosition = 0;
  // Marked-to-market equity at the END of each bar — cash alone when flat, cash plus the open
  // position's unrealised value (at that bar's own close) otherwise. Used only for `maxDrawdown`
  // below; never fed back into any trading decision (no look-ahead risk — it's a pure by-product of
  // bar `i`'s own already-known close).
  const equityCurve: number[] = new Array(candles.length);
  // Signals detected at bar i are queued and only acted on at bar i + 1's open — this is the one
  // piece of state that makes "next-bar execution" explicit and impossible to accidentally act on
  // the same bar the signal was observed.
  let pendingEntrySignalBar: number | undefined;
  let pendingExitReason: TradeExitReason | undefined;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]!;

    // Act on whatever was queued from the PREVIOUS bar's own signal evaluation — this is the only
    // place an order is ever executed, and it always uses bar `i`'s OPEN, never bar `i`'s own close
    // or any later bar.
    if (openPosition && pendingExitReason) {
      const { trade, cashAfterExit } = closeTrade(openPosition, cash, i, bar.timestamp, bar.open, pendingExitReason, feeRate, slippageRate);
      trades.push(trade);
      cash = cashAfterExit;
      openPosition = undefined;
      pendingExitReason = undefined;
    } else if (!openPosition && pendingEntrySignalBar !== undefined) {
      const entryPriceRaw = bar.open;
      const entryPriceExecuted = entryPriceRaw * (1 + slippageRate);
      const { quantity, entryFee } = sizePosition(cash, entryPriceExecuted, feeRate);
      cash -= entryFee;
      openPosition = { entryBarIndex: i, entryTimestamp: bar.timestamp, entryPriceRaw, entryPriceExecuted, quantity, entryFee };
      pendingEntrySignalBar = undefined;
    }

    if (openPosition) barsInPosition += 1;
    // `cash` is left UNCHANGED between entry and exit (see the two branches above) — it already
    // reflects the position's own entry notional minus the entry fee, so marking-to-market only
    // ever needs to ADD the unrealised price DELTA since entry, never the bar's own absolute close
    // value on top of `cash` (which would double-count the invested notional).
    equityCurve[i] = openPosition ? cash + (bar.close - openPosition.entryPriceExecuted) * openPosition.quantity : cash;

    // Evaluate THIS bar's own signals, to be acted on at the NEXT bar's open — never the same bar.
    if (openPosition) {
      const barsHeldSoFar = i - openPosition.entryBarIndex;
      const maxBarsRule = document.signalExitRules.find((r) => r.kind === "MAX_BARS_HELD");
      const conditionRules = document.signalExitRules.filter((r) => r.kind === "CONDITION");
      const maxBarsHit = maxBarsRule?.kind === "MAX_BARS_HELD" && barsHeldSoFar >= maxBarsRule.maxBars;
      const conditionHit = conditionRules.some((r) => r.kind === "CONDITION" && evaluateRuleNode(r.rule, candles, series, i));
      if (maxBarsHit || conditionHit) {
        pendingExitReason = maxBarsHit && !conditionHit ? "MAX_BARS_HELD" : "SIGNAL";
      }
    } else if (i >= warmupBars && evaluateRuleNode(document.entryRules, candles, series, i)) {
      pendingEntrySignalBar = i;
    }
  }

  // End-of-data policy: an OPEN position (or a pending, never-actioned entry signal on the very
  // last bar) is resolved deterministically here — never left dangling, never assumed to close at
  // an unknowable future price.
  if (openPosition) {
    const last = candles[candles.length - 1]!;
    const { trade, cashAfterExit } = closeTrade(openPosition, cash, candles.length - 1, last.timestamp, last.close, "END_OF_DATA", feeRate, slippageRate);
    trades.push(trade);
    cash = cashAfterExit;
    equityCurve[candles.length - 1] = cash;
  }

  return computeSegmentMetrics(candles, config.startingCapital, cash, trades, barsInPosition, equityCurve);
}

function computeSegmentMetrics(
  candles: readonly Candle[],
  startingCapital: number,
  endingCapital: number,
  trades: readonly BacktestTrade[],
  barsInPosition: number,
  equityCurve: readonly number[],
): BacktestSegmentMetrics {
  const grossPnl = trades.reduce((sum, t) => sum + t.grossPnl, 0);
  const netPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.feesPaid, 0);
  const totalSlippageCost = trades.reduce((sum, t) => sum + t.slippageCost, 0);
  const winners = trades.filter((t) => t.netPnl > 0);
  const losers = trades.filter((t) => t.netPnl < 0);
  const grossWin = winners.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.netPnl, 0));

  // Marked-to-market, bar-by-bar — see `BacktestSegmentMetrics.maxDrawdown`'s own doc comment for
  // why this is not merely derived from closed-trade P&L.
  let peak = startingCapital;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    barCount: candles.length,
    startTimestamp: candles[0]!.timestamp,
    endTimestamp: candles[candles.length - 1]!.timestamp,
    startingCapital,
    endingCapital,
    totalReturn: startingCapital > 0 ? (endingCapital - startingCapital) / startingCapital : 0,
    grossPnl,
    netPnl,
    totalFees,
    totalSlippageCost,
    tradeCount: trades.length,
    winRate: trades.length > 0 ? winners.length / trades.length : 0,
    maxDrawdown,
    averageTrade: trades.length > 0 ? netPnl / trades.length : 0,
    // `null`, never Infinity — a JSON-serialisable, unambiguous "there were no losing trades to
    // divide by" signal rather than a value that silently becomes `null` through JSON.stringify
    // anyway (JSON has no Infinity literal) with no indication of why. Covers BOTH "zero trades at
    // all" and "every trade was a net winner."
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    exposurePercentage: candles.length > 0 ? (barsInPosition / candles.length) * 100 : 0,
    trades: [...trades],
  };
}
