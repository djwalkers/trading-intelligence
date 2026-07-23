import { calculateHoldingDurationMs, calculateRealisedPnl, calculateUnrealizedPnl } from "../trade-lifecycle/calculations";
import { computeTradeLevels } from "../trade-approval/build-trade-candidate";
import type { AnalysisRepository } from "../analysis/analysis-repository";
import type { AnalysisRun } from "../analysis/types";
import type { StrategyRegistry } from "../strategies/strategy-registry";
import type { MarketDecisionContext } from "../market-decision-engine";
import { canReconstructContext, reconstructContext } from "./reconstruct-context";
import { buildResearchEquityCurve, computeResearchMetrics } from "./research-metrics";
import type { ResearchDecisionPoint, ResearchRunParams, ResearchRunResult, SimulatedTrade } from "./types";

// Phase 5 — Strategy Research Laboratory. THE simulation engine. Never places a trade, never calls
// a broker, PortfolioRiskEngine, or TradeCandidateRepository, never writes anything anywhere — it
// only READS already-persisted AnalysisRun rows (via the existing, unmodified AnalysisRepository
// interface — the exact same one the Decision Intelligence page and GET /api/hermes/analysis
// already read from) and calls a Strategy's own, unmodified evaluate() against reconstructed
// historical contexts. Every P/L formula reused here (calculateRealisedPnl,
// calculateHoldingDurationMs, calculateUnrealizedPnl) is imported, never duplicated or altered, from
// trade-lifecycle/calculations.ts — the exact same math a real, live trade would have used.
//
// Position simulation is entirely local to this run: `positionOpen` starts false and is tracked
// independently for whichever Strategy is being tested, never read from — or written to — any
// live broker, TradeLifecycleStore, or TradeCandidateRepository. Two different strategies run over
// the identical historical window therefore simulate their OWN, independently diverging position
// state — which is the entire point of a research comparison (see research-comparison.ts).

const DEFAULT_AMOUNT = 10;
const MAX_ANALYSIS_ROWS = 5000;

function riskMultipleFor(grossPnl: number, entryPrice: number, stopLoss: number, amount: number): number | undefined {
  const dollarRisk = Math.abs(entryPrice - stopLoss) * amount;
  if (!Number.isFinite(dollarRisk) || dollarRisk <= 0) return undefined;
  return grossPnl / dollarRisk;
}

export interface RunStrategyResearchInput {
  repository: AnalysisRepository;
  registry: StrategyRegistry;
  params: ResearchRunParams;
}

export async function runStrategyResearch(input: RunStrategyResearchInput): Promise<ResearchRunResult> {
  const { repository, registry, params } = input;
  const strategy = registry.require(params.strategyId); // throws UnknownStrategyError — fail closed, same convention as the live engine
  const amount = params.amount ?? DEFAULT_AMOUNT;

  const fetched = await repository.getRecentAnalyses({
    instrument: params.instrument,
    since: params.since,
    until: params.until,
    limit: MAX_ANALYSIS_ROWS,
  });

  // getRecentAnalyses returns newest-first (see analysis-repository.ts) — a backtest replays
  // chronologically, oldest first, so this reverses it. A plain in-memory sort over an already-
  // fetched array, not a query change.
  const usable = fetched.filter((run): run is AnalysisRun => run.decision !== "ERROR" && canReconstructContext(run));
  const ordered = [...usable].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const decisionPoints: ResearchDecisionPoint[] = [];
  const trades: SimulatedTrade[] = [];

  let positionOpen = false;
  let entryContext: MarketDecisionContext | undefined;
  let entryPrice = 0;
  let entryTime = "";
  let peak = 0;
  let trough = 0;

  for (const run of ordered) {
    const context = reconstructContext(run, { strategyId: strategy.id, strategyVersion: strategy.version, positionOpen });
    const decision = strategy.evaluate(context);
    decisionPoints.push({
      analysisRunId: run.id,
      context,
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    });

    if (positionOpen) {
      const unrealised = calculateUnrealizedPnl("BUY", entryPrice, context.bid, amount);
      peak = Math.max(peak, unrealised, 0);
      trough = Math.min(trough, unrealised, 0);
    }

    if (decision.action === "BUY" && !positionOpen) {
      positionOpen = true;
      entryContext = context;
      entryPrice = context.ask;
      entryTime = context.timestamp;
      peak = 0;
      trough = 0;
    } else if (decision.action === "SELL" && positionOpen && entryContext) {
      const exitPrice = context.bid;
      const exitTime = context.timestamp;
      const grossPnl = calculateRealisedPnl("BUY", entryPrice, exitPrice, amount);
      const entryNotional = entryPrice * amount;
      const returnPercent = entryNotional > 0 ? (grossPnl / entryNotional) * 100 : 0;
      const holdingTimeMs = calculateHoldingDurationMs(entryTime, exitTime);
      const levels = computeTradeLevels(entryContext, "BUY");

      trades.push({
        entryTime,
        entryPrice,
        exitTime,
        exitPrice,
        holdingTimeMs,
        grossPnl,
        returnPercent,
        riskMultiple: riskMultipleFor(grossPnl, entryPrice, levels.stopLoss, amount),
        maxFavourableExcursion: peak,
        maxAdverseExcursion: trough,
      });

      positionOpen = false;
      entryContext = undefined;
    }
    // HOLD, or a BUY/SELL that isn't actionable given the current simulated position state (e.g. a
    // BUY while already open — cannot happen given Demo0001-family rules, but never silently
    // "handled" either way if a future strategy's own logic ever produced one): simply no trade.
  }

  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    instrument: params.instrument,
    since: params.since,
    until: params.until,
    decisionPoints,
    trades,
    equityCurve: buildResearchEquityCurve(trades),
    metrics: computeResearchMetrics(decisionPoints, trades, { since: params.since, until: params.until }),
  };
}
