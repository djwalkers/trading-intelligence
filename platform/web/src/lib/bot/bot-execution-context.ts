import type { Instrument, PaperTrade } from "@/lib/types";
import { runBotScan } from "./bot-runner";
import type { BotDecision, BotScanResult, ScanTriggerType } from "./types";

// The side effects a scan needs beyond pure computation: reading the trades a candidate is
// evaluated against, and (if the scan opens one) persisting the new trade, always persisting the
// decision. runBotScan() itself has no persistence or browser dependency at all (Mission 1) — this
// interface is what lets the exact same scan orchestration run from the browser (BotRunnerPanel,
// backed by PaperTradesProvider/BotDecisionLogProvider) or from a future background worker
// (Mission 7, backed by a service-role client — see server-execution-context.ts) without either
// one duplicating or drifting from the risk pipeline's persistence behaviour.
export interface BotExecutionContext {
  loadTrades(): Promise<PaperTrade[]>;
  persistTrade(trade: PaperTrade): Promise<void>;
  persistDecision(decision: BotDecision): Promise<void>;
}

// Runs one full scan — individual risk, Position Manager, portfolio risk, max-one-trade-per-scan
// (all inside runBotScan, unchanged) — then applies both persistence side effects through
// whichever BotExecutionContext the caller supplies. This is the one place "run a scan and save
// the result" is implemented; every caller (browser panel, future worker) goes through here rather
// than calling runBotScan() directly, so persistence behaviour can't diverge between them.
export async function executeBotScan(params: {
  instruments: Instrument[];
  scanId: string;
  triggerType: ScanTriggerType;
  context: BotExecutionContext;
}): Promise<BotScanResult> {
  const { instruments, scanId, triggerType, context } = params;
  const trades = await context.loadTrades();
  const result = await runBotScan(instruments, trades, scanId, triggerType);
  if (result.trade) await context.persistTrade(result.trade);
  await context.persistDecision(result.decision);
  return result;
}
