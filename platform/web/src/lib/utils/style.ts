import type {
  MarketRegime,
  PaperTradeSource,
  PaperTradeStatus,
  Recommendation,
  RiskLevel,
  ServiceState,
  SignalType,
  StrategyStatus,
  VolatilityLevel,
} from "@/lib/types";

export function signalToneClasses(signalType: SignalType): string {
  switch (signalType) {
    case "BUY":
      return "bg-accent-teal/10 text-accent-teal border-accent-teal/30";
    case "SELL":
      return "bg-accent-red/10 text-accent-red border-accent-red/30";
    case "HOLD":
      return "bg-accent-amber/10 text-accent-amber border-accent-amber/30";
  }
}

export function strategyStatusClasses(status: StrategyStatus): string {
  switch (status) {
    case "active":
      return "bg-accent-teal/10 text-accent-teal border-accent-teal/30";
    case "paused":
      return "bg-ink-500/10 text-ink-400 border-ink-500/30";
    case "backtesting":
      return "bg-accent-blue/10 text-accent-blue border-accent-blue/30";
  }
}

export function serviceStateClasses(state: ServiceState): string {
  switch (state) {
    case "running":
      return "bg-accent-teal/10 text-accent-teal border-accent-teal/30";
    case "mocked":
      return "bg-accent-blue/10 text-accent-blue border-accent-blue/30";
    case "passive":
      return "bg-accent-amber/10 text-accent-amber border-accent-amber/30";
    case "not_connected":
      return "bg-ink-500/10 text-ink-400 border-ink-500/30";
    case "disabled":
      return "bg-accent-red/10 text-accent-red border-accent-red/30";
  }
}

export function serviceStateLabel(state: ServiceState): string {
  switch (state) {
    case "running":
      return "Running";
    case "mocked":
      return "Mocked";
    case "passive":
      return "Passive";
    case "not_connected":
      return "Not Connected";
    case "disabled":
      return "Disabled";
  }
}

export function strategyStatusLabel(status: StrategyStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "backtesting":
      return "Backtesting";
  }
}

export function paperTradeStatusClasses(status: PaperTradeStatus): string {
  switch (status) {
    case "Open":
      return "bg-accent-blue/10 text-accent-blue border-accent-blue/30";
    case "Closed":
      return "bg-ink-500/10 text-ink-400 border-ink-500/30";
  }
}

// Restrained, mostly-neutral tones — colour is reserved for the two extremes only,
// so confidence reads through layout and hierarchy rather than a "traffic light" of colour.
export function recommendationClasses(recommendation: Recommendation): string {
  switch (recommendation) {
    case "Strong Buy":
      return "border-accent-teal/40 bg-accent-teal/10 text-accent-teal";
    case "Buy":
      return "border-accent-teal/25 bg-base-800 text-ink-100";
    case "Hold":
      return "border-base-600 bg-base-800 text-ink-300";
    case "Avoid":
      return "border-accent-amber/25 bg-base-800 text-ink-100";
    case "Strong Sell":
      return "border-accent-red/40 bg-accent-red/10 text-accent-red";
  }
}

export function marketRegimeClasses(regime: MarketRegime): string {
  switch (regime) {
    case "Bullish":
      return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
    case "Neutral":
      return "border-base-600 bg-base-800 text-ink-300";
    case "Bearish":
      return "border-accent-red/30 bg-accent-red/10 text-accent-red";
  }
}

export function volatilityClasses(level: VolatilityLevel): string {
  switch (level) {
    case "Low":
      return "border-base-600 bg-base-800 text-ink-300";
    case "Medium":
      return "border-base-600 bg-base-800 text-ink-200";
    case "High":
      return "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
  }
}

export function riskLevelClasses(level: RiskLevel): string {
  switch (level) {
    case "Low":
      return "border-base-600 bg-base-800 text-ink-300";
    case "Moderate":
      return "border-base-600 bg-base-800 text-ink-200";
    case "Elevated":
      return "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
  }
}

export function tradeSourceClasses(source: PaperTradeSource): string {
  switch (source) {
    case "Signal":
      return "border-base-600 bg-base-800 text-ink-300";
    case "Market Intelligence":
      return "border-accent-blue/25 bg-accent-blue/10 text-accent-blue";
  }
}

export function plToneClass(value: number): string {
  if (value > 0) return "text-accent-teal";
  if (value < 0) return "text-accent-red";
  return "text-ink-400";
}
