export type StrategyStatus = "active" | "paused" | "backtesting";

export interface Strategy {
  id: string;
  name: string;
  description: string;
  status: StrategyStatus;
  instrumentsCovered: string[];
  signalsGenerated30d: number;
  winRatePercent: number;
  createdAt: string;
}
