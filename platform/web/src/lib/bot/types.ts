import type { AgreementLevel, PaperTrade, PaperTradeSide } from "@/lib/types";

export interface BotRiskCheck {
  name: string;
  passed: boolean;
  detail: string;
}

// One ranked candidate's full evaluation — whether it was the one that opened a trade, was
// rejected in favour of trying the next-ranked candidate, or (last in the list) rejected with
// nothing left to fall back to. Every risk check for a candidate always runs and is always
// recorded, whether it passed or not.
export interface BotCandidateEvaluation {
  rank: number;
  instrumentSymbol: string;
  instrumentName: string;
  side: PaperTradeSide;
  confidence: number;
  agreement: AgreementLevel;
  riskChecks: BotRiskCheck[];
  outcome: "Trade Opened" | "Rejected";
  rejectionReason?: string;
}

// One line of the scan's step-by-step trace (scan started → instruments scanned → candidates
// ranked → each candidate evaluated/rejected → trade opened or not → scan completed).
export interface BotTraceStep {
  step: string;
  detail: string;
}

// Not barrel-exported through @/lib/types — this is a self-contained Mission 1 feature, not a
// core domain concept the rest of the app needs to reference broadly (unlike PaperTrade or
// StrategyScore). Components that need it import directly from src/lib/bot/.
export interface BotDecision {
  id: string;
  scanId: string;
  timestamp: string;
  instrumentsScanned: string[];
  // Every candidate walked during the fallback loop, in ranked order — not just the winner.
  candidates: BotCandidateEvaluation[];
  selectedInstrument: string | null;
  selectedInstrumentName: string | null;
  actionTaken: "Trade Opened" | "No Trade";
  reason: string;
  trace: BotTraceStep[];
  tradeCreated: boolean;
  createdTradeId?: string;
  executionTimeMs: number;
}

export interface BotScanResult {
  decision: BotDecision;
  // Non-null only when some candidate passed every risk check — the caller (a React client
  // component) is responsible for actually calling addTrade(); runBotScan itself never touches
  // persistence.
  trade: PaperTrade | null;
}
