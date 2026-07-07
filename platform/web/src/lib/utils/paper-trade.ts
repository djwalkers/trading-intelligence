import type { Opportunity, PaperTrade, PaperTradeSide, Recommendation, Signal } from "@/lib/types";
import { getInstrumentBySymbol } from "@/lib/mock/instruments";

const TARGET_NOTIONAL = 250;
const MARKET_INTELLIGENCE_MODEL_NAME = "Market Intelligence Engine";

function quantityForEntryPrice(entryPrice: number): number {
  return Math.max(1, Math.round(TARGET_NOTIONAL / (entryPrice || 1)));
}

// Small, fixed per-instrument drift so open positions and closed trades can show a realistic
// non-zero P/L. This is deliberately NOT a live price feed — it only marks paper trades, and
// never changes the Watchlist, Dashboard, or any other instrument price display.
const MOCK_PRICE_DRIFT_PERCENT: Record<string, number> = {
  AAPL: 0.6,
  MSFT: 1.1,
  TSLA: -2.4,
  NVDA: 2.8,
  SPY: 0.3,
};

export function getCurrentMockPrice(symbol: string): number {
  const instrument = getInstrumentBySymbol(symbol);
  const basePrice = instrument?.price ?? 0;
  const driftPercent = MOCK_PRICE_DRIFT_PERCENT[symbol] ?? 0;
  return Math.round(basePrice * (1 + driftPercent / 100) * 100) / 100;
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

export function buildClosedTrade(trade: PaperTrade): PaperTrade {
  const exitPrice = getCurrentMockPrice(trade.instrumentSymbol);

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

export function calculatePaperTradePerformance(trades: PaperTrade[]): PaperTradePerformance {
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
      unrealisedPnl += calculateTradePnl(trade, getCurrentMockPrice(trade.instrumentSymbol));
    }
  }

  return { openCount, closedCount, realisedPnl, unrealisedPnl, totalPnl: realisedPnl + unrealisedPnl };
}

export function isTradeableSignal(signal: Signal): boolean {
  return signal.signalType === "BUY" || signal.signalType === "SELL";
}

export function buildPaperTradeFromSignal(signal: Signal): PaperTrade {
  const instrument = getInstrumentBySymbol(signal.instrumentSymbol);
  const entryPrice = instrument?.price ?? 0;

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

function sideForRecommendation(recommendation: Recommendation): PaperTradeSide {
  return recommendation === "Strong Sell" ? "SELL" : "BUY";
}

export function buildPaperTradeFromOpportunity(opportunity: Opportunity): PaperTrade {
  const instrument = getInstrumentBySymbol(opportunity.instrumentSymbol);
  const entryPrice = instrument?.price ?? 0;

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
  };
}
