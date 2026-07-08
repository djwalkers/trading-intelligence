import type { PaperTrade, PaperTradeSide, PortfolioExposureSnapshot } from "@/lib/types";
import { paperPortfolio } from "@/lib/mock/portfolio";
import { getSectorForSymbol } from "@/lib/mock/sectors";
import type { BotRiskCheck } from "./types";

// Hardcoded, disclosed, and deliberately simple — this is Mission 2's Portfolio Risk Manager v1,
// not a configurable risk engine. Adjusting any of these means editing this file, not a settings
// screen. Percent-based limits are measured against starting paper capital
// (paperPortfolio.startingValue, the same fixed base already used elsewhere in this app), not
// against current portfolio value — a moving target would make the limit itself drift as trades
// open and close.
export const MAX_OPEN_TRADES = 5;
export const MAX_CAPITAL_DEPLOYED_PERCENT = 60;
export const MAX_SECTOR_EXPOSURE_PERCENT = 30;
export const MAX_SECTOR_OPEN_TRADES = 3;
export const MIN_CASH_REMAINING_GBP = 1000;
export const MAX_SAME_DIRECTION_TRADES = 4;

export interface PortfolioRiskResult {
  passed: boolean;
  checks: BotRiskCheck[];
}

// The portfolio's current state, before considering any new candidate — computed once per scan
// (every candidate in that scan is checked against the same baseline, since at most one trade
// ever opens per scan) and reused both as the trace's exposure snapshot and as the input every
// portfolio risk check adds a candidate's prospective trade onto.
export function buildExposureSnapshot(trades: PaperTrade[]): PortfolioExposureSnapshot {
  const openTrades = trades.filter((trade) => trade.status === "Open");
  const closedTrades = trades.filter((trade) => trade.status === "Closed");

  const capitalByInstrument: Record<string, number> = {};
  const capitalBySide: Record<PaperTradeSide, number> = { BUY: 0, SELL: 0 };
  const countBySide: Record<PaperTradeSide, number> = { BUY: 0, SELL: 0 };
  const capitalBySector: Record<string, number> = {};
  const countBySector: Record<string, number> = {};
  let totalCapitalDeployed = 0;

  for (const trade of openTrades) {
    const notional = trade.quantity * trade.entryPrice;
    totalCapitalDeployed += notional;
    capitalByInstrument[trade.instrumentSymbol] =
      (capitalByInstrument[trade.instrumentSymbol] ?? 0) + notional;
    capitalBySide[trade.side] += notional;
    countBySide[trade.side] += 1;
    const sector = getSectorForSymbol(trade.instrumentSymbol);
    capitalBySector[sector] = (capitalBySector[sector] ?? 0) + notional;
    countBySector[sector] = (countBySector[sector] ?? 0) + 1;
  }

  // Mirrors PortfolioView's adjustedCashBalance exactly (paperPortfolio.cashBalance - committed
  // capital + realised P/L), so the Bot Runner reasons about the same available cash a human sees
  // on the Paper Portfolio page, not a second, independent notion of "cash."
  const realisedPnl = closedTrades.reduce((sum, trade) => sum + (trade.realisedPnl ?? 0), 0);
  const availableCash = paperPortfolio.cashBalance - totalCapitalDeployed + realisedPnl;

  return {
    totalOpenTrades: openTrades.length,
    totalCapitalDeployed,
    availableCash,
    startingCapital: paperPortfolio.startingValue,
    capitalByInstrument,
    capitalBySide,
    countBySide,
    capitalBySector,
    countBySector,
  };
}

// Evaluates whether opening one more candidate trade on top of the given baseline snapshot is
// appropriate for the whole portfolio, not just the individual opportunity. Every check always
// runs and is always returned, whether it passed or not — same convention as the individual risk
// checks in bot-runner.ts. Only called once a candidate has already passed every individual check
// (see runBotScan) — candidateNotional is that candidate's actual position size.
export function evaluatePortfolioRisk(
  snapshot: PortfolioExposureSnapshot,
  candidateSymbol: string,
  candidateSide: PaperTradeSide,
  candidateNotional: number,
): PortfolioRiskResult {
  const sector = getSectorForSymbol(candidateSymbol);
  const checks: BotRiskCheck[] = [];

  const openTradesAfter = snapshot.totalOpenTrades + 1;
  const openTradesPassed = openTradesAfter <= MAX_OPEN_TRADES;
  checks.push({
    name: "Max open trades",
    passed: openTradesPassed,
    detail: `${openTradesAfter} open trade(s) after this trade ${
      openTradesPassed ? "is within" : "would exceed"
    } the ${MAX_OPEN_TRADES}-trade limit.`,
  });

  const capitalLimit = (MAX_CAPITAL_DEPLOYED_PERCENT / 100) * snapshot.startingCapital;
  const capitalDeployedAfter = snapshot.totalCapitalDeployed + candidateNotional;
  const capitalPassed = capitalDeployedAfter <= capitalLimit;
  checks.push({
    name: "Max capital deployed",
    passed: capitalPassed,
    detail: `£${capitalDeployedAfter.toFixed(2)} deployed after this trade ${
      capitalPassed ? "is within" : "would exceed"
    } the ${MAX_CAPITAL_DEPLOYED_PERCENT}% (£${capitalLimit.toFixed(2)}) limit of starting capital.`,
  });

  const sectorLimit = (MAX_SECTOR_EXPOSURE_PERCENT / 100) * snapshot.startingCapital;
  const sectorCapitalAfter = (snapshot.capitalBySector[sector] ?? 0) + candidateNotional;
  const sectorExposurePassed = sectorCapitalAfter <= sectorLimit;
  checks.push({
    name: "Max sector exposure",
    passed: sectorExposurePassed,
    detail: `${sector} exposure would be £${sectorCapitalAfter.toFixed(2)} after this trade, ${
      sectorExposurePassed ? "within" : "exceeding"
    } the ${MAX_SECTOR_EXPOSURE_PERCENT}% (£${sectorLimit.toFixed(2)}) limit.`,
  });

  const sectorCountAfter = (snapshot.countBySector[sector] ?? 0) + 1;
  const sectorCountPassed = sectorCountAfter <= MAX_SECTOR_OPEN_TRADES;
  checks.push({
    name: "Max open trades per sector",
    passed: sectorCountPassed,
    detail: `${sectorCountAfter} open ${sector} trade(s) after this trade ${
      sectorCountPassed ? "is within" : "would exceed"
    } the ${MAX_SECTOR_OPEN_TRADES}-trade sector limit.`,
  });

  const cashAfter = snapshot.availableCash - candidateNotional;
  const cashPassed = cashAfter >= MIN_CASH_REMAINING_GBP;
  checks.push({
    name: "Minimum cash remaining",
    passed: cashPassed,
    detail: `£${cashAfter.toFixed(2)} paper cash would remain after this trade, ${
      cashPassed ? "at or above" : "below"
    } the £${MIN_CASH_REMAINING_GBP} minimum.`,
  });

  const sideCountAfter = snapshot.countBySide[candidateSide] + 1;
  const sidePassed = sideCountAfter <= MAX_SAME_DIRECTION_TRADES;
  checks.push({
    name: "Max same-direction trades",
    passed: sidePassed,
    detail: `${sideCountAfter} open ${candidateSide} trade(s) after this trade ${
      sidePassed ? "is within" : "would exceed"
    } the ${MAX_SAME_DIRECTION_TRADES}-trade same-direction limit.`,
  });

  return { passed: checks.every((check) => check.passed), checks };
}
