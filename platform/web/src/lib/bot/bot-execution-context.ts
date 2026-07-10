import type { Instrument, PaperTrade } from "@/lib/types";
import type { DecisionRecord } from "@/lib/decision-intelligence/types";
import type { HistoricalMarketDataProvider } from "@/lib/market-data/historical-market-data-provider";
import { buildDecisionRecords } from "@/lib/decision-intelligence/build-decision-records";
import { runBotScan } from "./bot-runner";
import type { BotDecision, BotScanResult, ScanTriggerType } from "./types";

// The side effects a scan needs beyond pure computation: reading the trades a candidate is
// evaluated against, and (if the scan opens one) persisting the new trade, always persisting the
// decision, and (Mission 7) always persisting one DecisionRecord per candidate evaluated — accepted
// or rejected. runBotScan() itself has no persistence or browser dependency at all (Mission 1) —
// this interface is what lets the exact same scan orchestration run from the browser
// (BotRunnerPanel, backed by PaperTradesProvider/BotDecisionLogProvider/DecisionHistoryProvider) or
// from a future background worker (Mission 6/7, backed by a service-role client — see
// server-execution-context.ts) without either one duplicating or drifting from the risk pipeline's
// persistence behaviour.
export interface BotExecutionContext {
  loadTrades(): Promise<PaperTrade[]>;
  persistTrade(trade: PaperTrade): Promise<void>;
  persistDecision(decision: BotDecision): Promise<void>;
  persistDecisionRecords(records: DecisionRecord[]): Promise<void>;
}

// Runs one full scan — individual risk, Position Manager, portfolio risk, max-one-trade-per-scan
// (all inside runBotScan, unchanged) — then applies every persistence side effect through whichever
// BotExecutionContext the caller supplies. This is the one place "run a scan and save the result"
// is implemented; every caller (browser panel, future worker) goes through here rather than calling
// runBotScan() directly, so persistence behaviour can't diverge between them.
export async function executeBotScan(params: {
  instruments: Instrument[];
  scanId: string;
  triggerType: ScanTriggerType;
  context: BotExecutionContext;
  // Optional — Maintenance 1.11.2. Only the VPS worker passes one (its own server-only,
  // Alpha-Vantage-capable provider, resolved in src/worker/process-schedule.ts); the browser never
  // does, so runBotScan()/evaluateAllWithHistory() fall back to the existing client-safe singleton.
  historicalMarketDataProvider?: HistoricalMarketDataProvider;
}): Promise<BotScanResult> {
  const { instruments, scanId, triggerType, context, historicalMarketDataProvider } = params;
  const trades = await context.loadTrades();
  const result = await runBotScan(instruments, trades, scanId, triggerType, historicalMarketDataProvider);
  if (result.trade) await context.persistTrade(result.trade);
  await context.persistDecision(result.decision);
  // Every candidate the scan considered becomes a DecisionRecord — accepted and rejected alike —
  // not just the one that opened a trade. See docs/product/MISSION-7-DECISION-INTELLIGENCE.md.
  await context.persistDecisionRecords(buildDecisionRecords(result.decision));
  return result;
}
