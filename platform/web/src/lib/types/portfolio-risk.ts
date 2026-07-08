import type { PaperTradeSide } from "./paper-trade";

// A point-in-time snapshot of open-trade exposure, computed by the Portfolio Risk Manager
// (Mission 2) immediately before evaluating a bot candidate — every candidate in the same scan is
// checked against the same baseline, since at most one trade ever opens per scan. Stored on
// Bot-sourced trades for audit purposes only; never read by any P/L calculation.
export interface PortfolioExposureSnapshot {
  totalOpenTrades: number;
  totalCapitalDeployed: number;
  availableCash: number;
  startingCapital: number;
  capitalByInstrument: Record<string, number>;
  capitalBySide: Record<PaperTradeSide, number>;
  countBySide: Record<PaperTradeSide, number>;
  capitalBySector: Record<string, number>;
  countBySector: Record<string, number>;
}
