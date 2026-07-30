// Main Dashboard Hermes/eToro fix. Plain DTOs matching the JSON shapes GET /api/hermes/portfolio,
// GET /api/hermes/positions, and GET /api/hermes/summary already return (via their browser-facing
// proxies — see dashboard-proxy.ts) — never re-derived or renamed here, so a shape change in those
// routes is a compile error here too, not a silent mismatch.

export interface HermesPortfolioData {
  accountMode: string;
  provider: string;
  cash: number;
  investedValue: number;
  realisedPnl: number | null;
  realisedPnlScope: string;
  unrealisedPnl: number | null;
  equity: number | null;
  openPositionCount: number;
  timestamp: string;
  positionsAreLiveGroundTruth: boolean;
}

export interface HermesPositionItem {
  instrument: string;
  side: "BUY" | "SELL" | "unknown";
  quantity: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealisedPnl: number | null;
  openedAt: string | null;
  provider: string;
  accountMode: string;
}

export interface HermesPositionsData {
  positions: HermesPositionItem[];
  count: number;
  provider: string;
  accountMode: string;
  positionsAreLiveGroundTruth: boolean;
}

export interface HermesSummaryData {
  timestamp: string;
  health: { status: string; runtimeMode: string; brokerProvider: string };
  runtime: { state: string; lastRunAt: string | null; successfulRunCount: number; failedRunCount: number } | null;
  openPositionCount: number | null;
  latestDecision: { timestamp: string; symbol: string; outcome: string; confidence: number | null } | null;
  recentFailure: { eventType: string; timestamp: string; message: string } | null;
  unreconciledClosures: unknown[];
  warnings: string[];
}
