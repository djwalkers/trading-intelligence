import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvidenceRating, PaperTrade, Recommendation } from "@/lib/types";
import type { PaperTradeStore } from "./paper-trade-store";

// Row shapes for the schema created in Build 0.7.0
// (platform/web/supabase/migrations/). Hand-written rather than generated, since no live
// Supabase project is linked to this repo to codegen against.
interface PaperTradeRow {
  id: string;
  client_trade_id: string;
  instrument_symbol: string;
  instrument_name: string;
  side: "BUY" | "SELL";
  quantity: number | string;
  entry_price: number | string;
  status: "Open" | "Closed";
  source: "Signal" | "Market Intelligence";
  strategy_name: string;
  reason: string;
  signal_confidence: number | string;
  source_signal_id: string | null;
  source_opportunity_id: string | null;
  exit_price: number | string | null;
  closed_at: string | null;
  realised_pnl: number | string | null;
  realised_pnl_percent: number | string | null;
  opened_at: string;
}

interface TradeIntelligenceRow {
  paper_trade_id: string;
  recommendation: Recommendation;
  evidence: EvidenceRating[];
  evidence_factors: string[];
  invalidation_factors: string[];
}

function toDbTrade(trade: PaperTrade) {
  return {
    client_trade_id: trade.id,
    instrument_symbol: trade.instrumentSymbol,
    instrument_name: trade.instrumentName,
    side: trade.side,
    quantity: trade.quantity,
    entry_price: trade.entryPrice,
    status: trade.status,
    source: trade.source,
    strategy_name: trade.strategyName,
    reason: trade.reason,
    signal_confidence: trade.signalConfidence,
    source_signal_id: trade.sourceSignalId ?? null,
    source_opportunity_id: trade.sourceOpportunityId ?? null,
    exit_price: trade.exitPrice ?? null,
    closed_at: trade.closedAt ?? null,
    realised_pnl: trade.realisedPnl ?? null,
    realised_pnl_percent: trade.realisedPnlPercent ?? null,
    opened_at: trade.timestamp,
  };
}

function toNumber(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  return typeof value === "number" ? value : Number(value);
}

function fromDbTrade(row: PaperTradeRow, intelligence: TradeIntelligenceRow | null): PaperTrade {
  return {
    id: row.client_trade_id,
    instrumentSymbol: row.instrument_symbol,
    instrumentName: row.instrument_name,
    side: row.side,
    quantity: toNumber(row.quantity) ?? 0,
    entryPrice: toNumber(row.entry_price) ?? 0,
    timestamp: row.opened_at,
    signalConfidence: toNumber(row.signal_confidence) ?? 0,
    strategyName: row.strategy_name,
    status: row.status,
    reason: row.reason,
    source: row.source,
    sourceSignalId: row.source_signal_id ?? undefined,
    sourceOpportunityId: row.source_opportunity_id ?? undefined,
    exitPrice: toNumber(row.exit_price),
    closedAt: row.closed_at ?? undefined,
    realisedPnl: toNumber(row.realised_pnl),
    realisedPnlPercent: toNumber(row.realised_pnl_percent),
    intelligence: intelligence
      ? {
          recommendation: intelligence.recommendation,
          evidence: intelligence.evidence,
          evidenceFactors: intelligence.evidence_factors,
          invalidationFactors: intelligence.invalidation_factors,
        }
      : undefined,
  };
}

// Real Supabase persistence against the schema from Build 0.7.0. Uses only the public anon key
// (never a service role key) — safe to construct and use directly in the browser, protected by
// the permissive-but-present RLS policies from 0005_row_level_security.sql.
export class SupabasePaperTradeStore implements PaperTradeStore {
  constructor(private readonly client: SupabaseClient) {}

  async load(): Promise<PaperTrade[]> {
    const { data: tradeRows, error: tradesError } = await this.client
      .from("paper_trades")
      .select("*")
      .order("opened_at", { ascending: false });

    if (tradesError) throw new Error(tradesError.message);
    if (!tradeRows || tradeRows.length === 0) return [];

    const tradeIds = tradeRows.map((row) => row.id);
    const { data: intelligenceRows, error: intelligenceError } = await this.client
      .from("trade_intelligence")
      .select("*")
      .in("paper_trade_id", tradeIds);

    if (intelligenceError) throw new Error(intelligenceError.message);

    const intelligenceByTradeId = new Map<string, TradeIntelligenceRow>(
      (intelligenceRows ?? []).map((row: TradeIntelligenceRow) => [row.paper_trade_id, row]),
    );

    return (tradeRows as PaperTradeRow[]).map((row) =>
      fromDbTrade(row, intelligenceByTradeId.get(row.id) ?? null),
    );
  }

  async addTrade(trade: PaperTrade): Promise<void> {
    const { data: inserted, error } = await this.client
      .from("paper_trades")
      .insert(toDbTrade(trade))
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    const paperTradeId = inserted.id as string;

    if (trade.intelligence) {
      const { error: intelligenceError } = await this.client.from("trade_intelligence").insert({
        paper_trade_id: paperTradeId,
        recommendation: trade.intelligence.recommendation,
        evidence: trade.intelligence.evidence,
        evidence_factors: trade.intelligence.evidenceFactors,
        invalidation_factors: trade.intelligence.invalidationFactors,
      });
      if (intelligenceError) throw new Error(intelligenceError.message);
    }

    const events = [
      {
        paper_trade_id: paperTradeId,
        event_type: "opened",
        event_at: trade.timestamp,
        price: trade.entryPrice,
      },
    ];

    // Covers importing a trade that was already closed before it existed in this store (see
    // the first-run import flow) — the audit trail gets both events even though, from this
    // store's point of view, they arrive at the same moment.
    if (trade.status === "Closed" && trade.exitPrice !== undefined && trade.closedAt) {
      events.push({
        paper_trade_id: paperTradeId,
        event_type: "closed",
        event_at: trade.closedAt,
        price: trade.exitPrice,
      });
    }

    const { error: eventsError } = await this.client.from("trade_events").insert(events);
    if (eventsError) throw new Error(eventsError.message);
  }

  async closeTrade(closedTrade: PaperTrade): Promise<void> {
    const { data: updated, error } = await this.client
      .from("paper_trades")
      .update({
        status: "Closed",
        exit_price: closedTrade.exitPrice ?? null,
        closed_at: closedTrade.closedAt ?? null,
        realised_pnl: closedTrade.realisedPnl ?? null,
        realised_pnl_percent: closedTrade.realisedPnlPercent ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("client_trade_id", closedTrade.id)
      .select("id")
      .single();

    if (error) throw new Error(error.message);

    const { error: eventError } = await this.client.from("trade_events").insert({
      paper_trade_id: updated.id as string,
      event_type: "closed",
      event_at: closedTrade.closedAt ?? new Date().toISOString(),
      price: closedTrade.exitPrice ?? closedTrade.entryPrice,
    });
    if (eventError) throw new Error(eventError.message);
  }
}
