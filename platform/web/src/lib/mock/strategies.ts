import type { Strategy } from "@/lib/types";

export const strategies: Strategy[] = [
  {
    id: "strat-momentum-breakout",
    name: "Momentum Breakout",
    description:
      "Flags instruments breaking above a 20-day high on above-average volume.",
    status: "active",
    instrumentsCovered: ["AAPL", "TSLA", "NVDA"],
    signalsGenerated30d: 14,
    winRatePercent: 58,
    createdAt: "2026-05-12T09:00:00Z",
  },
  {
    id: "strat-mean-reversion",
    name: "Mean Reversion",
    description:
      "Looks for short-term pullbacks to the 50-day moving average within an established uptrend.",
    status: "active",
    instrumentsCovered: ["MSFT", "SPY"],
    signalsGenerated30d: 9,
    winRatePercent: 62,
    createdAt: "2026-04-28T09:00:00Z",
  },
  {
    id: "strat-trend-following",
    name: "Trend Following",
    description:
      "Tracks moving-average crossovers to hold positions for the duration of a confirmed trend.",
    status: "active",
    instrumentsCovered: ["AAPL", "MSFT", "NVDA", "SPY"],
    signalsGenerated30d: 6,
    winRatePercent: 55,
    createdAt: "2026-03-15T09:00:00Z",
  },
  {
    id: "strat-volatility-filter",
    name: "Volatility Filter",
    description:
      "Backtesting a filter that suppresses signals during abnormally high intraday volatility.",
    status: "backtesting",
    instrumentsCovered: ["TSLA", "NVDA"],
    signalsGenerated30d: 0,
    winRatePercent: 0,
    createdAt: "2026-06-30T09:00:00Z",
  },
];
