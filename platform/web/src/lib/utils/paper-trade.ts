import type {
  EntryPriceInfo,
  Opportunity,
  PaperTrade,
  PaperTradeSide,
  Recommendation,
  Signal,
  StrategyScore,
} from "@/lib/types";

const TARGET_NOTIONAL = 250;
export const MARKET_INTELLIGENCE_MODEL_NAME = "Market Intelligence Engine";

export function quantityForEntryPrice(entryPrice: number): number {
  return Math.max(1, Math.round(TARGET_NOTIONAL / (entryPrice || 1)));
}

function pnlDirection(side: PaperTradeSide, entryPrice: number, markPrice: number): number {
  return side === "SELL" ? entryPrice - markPrice : markPrice - entryPrice;
}

export function calculateTradePnl(
  trade: Pick<PaperTrade, "side" | "entryPrice" | "quantity">,
  markPrice: number,
): number {
  return pnlDirection(trade.side, trade.entryPrice, markPrice) * trade.quantity;
}

export function calculateTradePnlPercent(
  trade: Pick<PaperTrade, "side" | "entryPrice">,
  markPrice: number,
): number {
  if (trade.entryPrice === 0) return 0;
  return (pnlDirection(trade.side, trade.entryPrice, markPrice) / trade.entryPrice) * 100;
}

export function buildClosedTrade(trade: PaperTrade, exitPrice: number): PaperTrade {
  return {
    ...trade,
    status: "Closed",
    exitPrice,
    closedAt: new Date().toISOString(),
    realisedPnl: calculateTradePnl(trade, exitPrice),
    realisedPnlPercent: calculateTradePnlPercent(trade, exitPrice),
  };
}

export interface PaperTradePerformance {
  openCount: number;
  closedCount: number;
  realisedPnl: number;
  unrealisedPnl: number;
  totalPnl: number;
}

// pricesBySymbol comes from the market data provider (see useMarketQuotes) — this function never
// sources a price itself. A missing entry (quote not loaded yet) falls back to entry price, which
// values the position at breakeven rather than showing a stale or wrong number.
export function calculatePaperTradePerformance(
  trades: PaperTrade[],
  pricesBySymbol: Record<string, number>,
): PaperTradePerformance {
  let openCount = 0;
  let closedCount = 0;
  let realisedPnl = 0;
  let unrealisedPnl = 0;

  for (const trade of trades) {
    if (trade.status === "Closed") {
      closedCount += 1;
      realisedPnl += trade.realisedPnl ?? 0;
    } else {
      openCount += 1;
      const markPrice = pricesBySymbol[trade.instrumentSymbol] ?? trade.entryPrice;
      unrealisedPnl += calculateTradePnl(trade, markPrice);
    }
  }

  return { openCount, closedCount, realisedPnl, unrealisedPnl, totalPnl: realisedPnl + unrealisedPnl };
}

export function isTradeableSignal(signal: Signal): boolean {
  return signal.signalType === "BUY" || signal.signalType === "SELL";
}

// entryPriceInfo comes from MarketDataProvider (see usePaperTradeEntryFlow) — this function never
// sources a price itself, matching the pattern already established for valuing existing trades
// (calculatePaperTradePerformance) rather than duplicating a second, independent price lookup.
export function buildPaperTradeFromSignal(signal: Signal, entryPriceInfo: EntryPriceInfo): PaperTrade {
  const entryPrice = entryPriceInfo.price;

  return {
    id: `trade-${signal.id}-${Date.now()}`,
    instrumentSymbol: signal.instrumentSymbol,
    instrumentName: signal.instrumentName,
    side: signal.signalType === "SELL" ? "SELL" : "BUY",
    quantity: quantityForEntryPrice(entryPrice),
    entryPrice,
    timestamp: new Date().toISOString(),
    signalConfidence: signal.confidencePercent,
    strategyName: signal.strategyName,
    status: "Open",
    reason: signal.reason,
    source: "Signal",
    sourceSignalId: signal.id,
    entryPriceSource: entryPriceInfo.source,
    entryPriceProvider: entryPriceInfo.provider,
    entryPriceTimestamp: entryPriceInfo.timestamp,
    // Sprint 290 — provenance must describe the data used to generate the originating
    // recommendation, not just whether the entry quote happened to connect. Signal generation
    // (src/lib/mock/signals.ts) carries no provenance concept to inherit today, so this is
    // classified conservatively rather than inferred from entryPriceInfo.mode.
    dataProvenance: "sample_data",
  };
}

// Never trade on Hold or Avoid — those calls mean "keep monitoring", not "act now".
// Only a clear Buy-side or Sell-side recommendation is tradeable.
export function isTradeableRecommendation(recommendation: Recommendation): boolean {
  return (
    recommendation === "Strong Buy" ||
    recommendation === "Buy" ||
    recommendation === "Strong Sell"
  );
}

export function sideForRecommendation(recommendation: Recommendation): PaperTradeSide {
  return recommendation === "Strong Sell" ? "SELL" : "BUY";
}

// strategyScore is optional only for type-level flexibility (e.g. tests constructing a trade
// without running the full engine) — every real call site in the app has one, since Market
// Intelligence always evaluates the engine for its opportunities.
export function buildPaperTradeFromOpportunity(
  opportunity: Opportunity,
  entryPriceInfo: EntryPriceInfo,
  strategyScore?: StrategyScore,
): PaperTrade {
  const entryPrice = entryPriceInfo.price;

  return {
    id: `trade-${opportunity.id}-${Date.now()}`,
    instrumentSymbol: opportunity.instrumentSymbol,
    instrumentName: opportunity.instrumentName,
    side: sideForRecommendation(opportunity.recommendation),
    quantity: quantityForEntryPrice(entryPrice),
    entryPrice,
    timestamp: new Date().toISOString(),
    signalConfidence: opportunity.confidencePercent,
    strategyName: MARKET_INTELLIGENCE_MODEL_NAME,
    status: "Open",
    reason: opportunity.narrative,
    source: "Market Intelligence",
    sourceOpportunityId: opportunity.id,
    intelligence: {
      recommendation: opportunity.recommendation,
      evidence: opportunity.evidence,
      evidenceFactors: opportunity.whyEvidence,
      invalidationFactors: opportunity.invalidationFactors,
    },
    entryPriceSource: entryPriceInfo.source,
    entryPriceProvider: entryPriceInfo.provider,
    entryPriceTimestamp: entryPriceInfo.timestamp,
    primaryStrategy: strategyScore?.primaryStrategyName,
    strategyAgreement: strategyScore?.agreement,
    overallConfidence: strategyScore?.overallConfidence,
    evidenceSummary: strategyScore?.agreementExplanation,
    // Sprint 290 — same rationale as buildPaperTradeFromSignal: Market Intelligence opportunity
    // generation carries no provenance concept to inherit today, so this is classified
    // conservatively rather than inferred from entryPriceInfo.mode.
    dataProvenance: "sample_data",
  };
}
