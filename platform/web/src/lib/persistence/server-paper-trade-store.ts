import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaperTrade } from "@/lib/types";
import {
  toDbTrade,
  fromDbTrade,
  type PaperTradeRow,
  type TradeIntelligenceRow,
} from "./supabase-paper-trade-store";

// Server-only mirror of SupabasePaperTradeStore's read/write logic, for a future worker acting on
// behalf of a user without a browser session (see
// docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md). Reuses the exact same row mapping
// (toDbTrade/fromDbTrade) as the browser store so the two can never drift into writing subtly
// different shapes — the only differences are how the client is authenticated (service role +
// explicit userId here, vs. anon key + session there) and that userId is a parameter instead of
// derived from a session. Nothing in the running app calls this yet — no worker exists (Mission 7).
//
// Deliberately does not implement closeTrade — no worker-driven close-trade flow exists or is
// requested as of Mission 6; add it here, mirroring SupabasePaperTradeStore.closeTrade, if one is
// ever built.

export async function loadTradesForUser(client: SupabaseClient, userId: string): Promise<PaperTrade[]> {
  const { data: tradeRows, error: tradesError } = await client
    .from("paper_trades")
    .select("*")
    .eq("user_id", userId)
    .order("opened_at", { ascending: false });

  if (tradesError) throw new Error(tradesError.message);
  if (!tradeRows || tradeRows.length === 0) return [];

  const tradeIds = tradeRows.map((row) => row.id);
  const { data: intelligenceRows, error: intelligenceError } = await client
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

// Returns the database-generated paper_trades.id (a uuid) — distinct from trade.id, the
// client-generated string PaperTrade identifier — so callers that need to reference this row
// elsewhere (e.g. bot_decisions.created_paper_trade_id, a uuid foreign key) have the right value.
export async function addTradeForUser(
  client: SupabaseClient,
  userId: string,
  trade: PaperTrade,
): Promise<string> {
  const { data: inserted, error } = await client
    .from("paper_trades")
    .insert({ ...toDbTrade(trade), user_id: userId })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  const paperTradeId = inserted.id as string;

  if (trade.intelligence) {
    const { error: intelligenceError } = await client.from("trade_intelligence").insert({
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

  if (trade.status === "Closed" && trade.exitPrice !== undefined && trade.closedAt) {
    events.push({
      paper_trade_id: paperTradeId,
      event_type: "closed",
      event_at: trade.closedAt,
      price: trade.exitPrice,
    });
  }

  const { error: eventsError } = await client.from("trade_events").insert(events);
  if (eventsError) throw new Error(eventsError.message);

  return paperTradeId;
}
