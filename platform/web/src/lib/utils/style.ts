import type {
  AgreementLevel,
  MarketRegime,
  PaperTradeSource,
  PaperTradeStatus,
  Recommendation,
  RiskLevel,
  ScoreBand,
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

// Same restrained pattern as recommendationClasses — colour flags the two extremes (unanimous
// agreement, genuine conflict) only; the two in-between levels stay neutral.
export function agreementLevelClasses(agreement: AgreementLevel): string {
  switch (agreement) {
    case "Strong Agreement":
      return "border-accent-teal/40 bg-accent-teal/10 text-accent-teal";
    case "Moderate Agreement":
      return "border-accent-teal/25 bg-base-800 text-ink-100";
    case "Mixed Signals":
      return "border-accent-amber/25 bg-base-800 text-ink-100";
    case "Conflict":
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
    case "Bot":
      return "border-accent-amber/25 bg-accent-amber/10 text-accent-amber";
  }
}

// Same restrained pattern as recommendationClasses — colour flags the two extremes
// (Excellent, Avoid) only; Good and Weak stay neutral so the number itself, not colour,
// carries the comparison.
export function scoreBandClasses(band: ScoreBand): string {
  switch (band) {
    case "Excellent":
      return "border-accent-teal/40 bg-accent-teal/10 text-accent-teal";
    case "Good":
      return "border-accent-teal/25 bg-base-800 text-ink-100";
    case "Weak":
      return "border-base-600 bg-base-800 text-ink-300";
    case "Avoid":
      return "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
  }
}

export function scoreBandLabel(band: ScoreBand): string {
  switch (band) {
    case "Excellent":
      return "Excellent";
    case "Good":
      return "Good";
    case "Weak":
      return "Weak";
    case "Avoid":
      return "Avoid";
  }
}

export function plToneClass(value: number): string {
  if (value > 0) return "text-accent-teal";
  if (value < 0) return "text-accent-red";
  return "text-ink-400";
}
