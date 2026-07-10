import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgreementLevel, PaperTradeSide, PositionAction } from "@/lib/types";
import type { ScanTriggerType } from "@/lib/bot/types";
import type { DecisionHistoryStore } from "./decision-history-store";
import type { DecisionOutcome, DecisionPortfolioRiskResult, DecisionRecord } from "./types";
import type { OutcomeUpdate } from "./outcome-analysis";
import { AuthRequiredError } from "@/lib/persistence/auth-required-error";

// Row shape for decision_history (0016_decision_history.sql, Mission 7). Exported so the
// server-only store (src/lib/decision-intelligence/server-decision-history-store.ts, Mission 6/7
// worker preparation) can reuse the exact same mapping instead of a second hand-written copy that
// could drift.
export interface DecisionHistoryRow {
  id: string;
  client_record_id: string;
  version: number;
  scan_id: string;
  source_decision_id: string;
  decided_at: string;
  trigger_type: ScanTriggerType;
  rank: number;
  instrument_symbol: string;
  instrument_name: string;
  sector: string;
  side: PaperTradeSide;
  entry_price: number | string | null;
  strategy_used: string;
  agreement: AgreementLevel;
  confidence: number | string;
  evidence_summary: string;
  deployed_capital: number | string;
  available_cash: number | string;
  sector_exposure: number | string;
  total_open_trades: number;
  action_taken: "Trade Opened" | "Rejected";
  rejection_reason: string | null;
  position_action: PositionAction | null;
  portfolio_risk_result: DecisionPortfolioRiskResult;
  outcome: DecisionOutcome;
  created_trade_id: string | null;
  // Mission 11 — null until outcome analysis classifies this record (see outcome-analysis.ts).
  realised_pnl: number | string | null;
  realised_pnl_percent: number | string | null;
  holding_duration_minutes: number | null;
  closed_at: string | null;
  outcome_recorded_at: string | null;
}

function toNumber(value: number | string | null): number {
  if (value === null) return 0;
  return typeof value === "number" ? value : Number(value);
}

export function toDbDecisionRecord(record: DecisionRecord) {
  return {
    client_record_id: record.id,
    version: record.version,
    scan_id: record.scanId,
    source_decision_id: record.sourceDecisionId,
    decided_at: record.timestamp,
    trigger_type: record.triggerType,
    rank: record.rank,
    instrument_symbol: record.symbol,
    instrument_name: record.instrumentName,
    sector: record.sector,
    side: record.side,
    entry_price: record.entryPrice,
    strategy_used: record.strategyUsed,
    agreement: record.agreement,
    confidence: record.confidence,
    evidence_summary: record.evidenceSummary,
    deployed_capital: record.deployedCapital,
    available_cash: record.availableCash,
    sector_exposure: record.sectorExposure,
    total_open_trades: record.totalOpenTrades,
    action_taken: record.actionTaken,
    rejection_reason: record.rejectionReason ?? null,
    position_action: record.positionAction ?? null,
    portfolio_risk_result: record.portfolioRiskResult,
    outcome: record.outcome,
    created_trade_id: record.createdTradeId ?? null,
    realised_pnl: record.realisedPnl ?? null,
    realised_pnl_percent: record.realisedPnlPercent ?? null,
    holding_duration_minutes: record.holdingDurationMinutes ?? null,
    closed_at: record.closedAt ?? null,
    outcome_recorded_at: record.outcomeRecordedAt ?? null,
  };
}

export function fromDbDecisionRecord(row: DecisionHistoryRow): DecisionRecord {
  return {
    version: row.version,
    id: row.client_record_id,
    scanId: row.scan_id,
    sourceDecisionId: row.source_decision_id,
    timestamp: row.decided_at,
    triggerType: row.trigger_type,
    rank: row.rank,
    symbol: row.instrument_symbol,
    instrumentName: row.instrument_name,
    sector: row.sector,
    side: row.side,
    entryPrice: row.entry_price === null ? null : toNumber(row.entry_price),
    strategyUsed: row.strategy_used,
    agreement: row.agreement,
    confidence: toNumber(row.confidence),
    evidenceSummary: row.evidence_summary,
    deployedCapital: toNumber(row.deployed_capital),
    availableCash: toNumber(row.available_cash),
    sectorExposure: toNumber(row.sector_exposure),
    totalOpenTrades: row.total_open_trades,
    actionTaken: row.action_taken,
    rejectionReason: row.rejection_reason ?? undefined,
    positionAction: row.position_action ?? undefined,
    portfolioRiskResult: row.portfolio_risk_result,
    outcome: row.outcome,
    createdTradeId: row.created_trade_id ?? undefined,
    // Loose nullish checks (not strict === null): until migration 0017 is applied to a given
    // Supabase project, these columns don't exist yet, so a `select("*")` response omits the key
    // entirely (row.realised_pnl is `undefined`, not `null`) — both cases must map to `undefined`
    // here, not fall through to toNumber(undefined), which would silently produce NaN.
    realisedPnl: row.realised_pnl == null ? undefined : toNumber(row.realised_pnl),
    realisedPnlPercent: row.realised_pnl_percent == null ? undefined : toNumber(row.realised_pnl_percent),
    holdingDurationMinutes: row.holding_duration_minutes ?? undefined,
    closedAt: row.closed_at ?? undefined,
    outcomeRecordedAt: row.outcome_recorded_at ?? undefined,
  };
}

// Real Supabase persistence against decision_history (0016_decision_history.sql). Uses only the
// public anon key (never a service role key) — safe to construct and use directly in the browser,
// protected by decision_history's user-scoped RLS policies, the same auth.uid() = user_id pattern
// paper_trades has used since Build 1.1.0.
export class SupabaseDecisionHistoryStore implements DecisionHistoryStore {
  constructor(private readonly client: SupabaseClient) {}

  private async requireUserId(): Promise<string> {
    const { data } = await this.client.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new AuthRequiredError();
    return userId;
  }

  async load(): Promise<DecisionRecord[]> {
    const userId = await this.requireUserId();

    const { data, error } = await this.client
      .from("decision_history")
      .select("*")
      .eq("user_id", userId)
      .order("decided_at", { ascending: false });

    if (error) throw new Error(error.message);
    return ((data ?? []) as DecisionHistoryRow[]).map(fromDbDecisionRecord);
  }

  async addRecords(records: DecisionRecord[]): Promise<void> {
    if (records.length === 0) return;
    const userId = await this.requireUserId();

    const rows = records.map((record) => ({ ...toDbDecisionRecord(record), user_id: userId }));
    const { error } = await this.client.from("decision_history").insert(rows);
    if (error) throw new Error(error.message);
  }

  // One UPDATE per record rather than a single batched call — PostgREST has no clean way to
  // upsert-with-different-values-per-row in one request, and reconciliation only ever touches a
  // handful of newly-closed trades at a time, so the simplicity is worth more than the round trips
  // here. Matched on client_record_id + user_id, both already indexed via RLS's own
  // auth.uid() = user_id policy and the table's primary access pattern.
  async updateOutcomes(updates: OutcomeUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const userId = await this.requireUserId();

    for (const update of updates) {
      const { error } = await this.client
        .from("decision_history")
        .update({
          outcome: update.outcome,
          realised_pnl: update.realisedPnl,
          realised_pnl_percent: update.realisedPnlPercent,
          holding_duration_minutes: update.holdingDurationMinutes,
          closed_at: update.closedAt,
          outcome_recorded_at: update.outcomeRecordedAt,
        })
        .eq("client_record_id", update.recordId)
        .eq("user_id", userId);
      if (error) throw new Error(error.message);
    }
  }
}
