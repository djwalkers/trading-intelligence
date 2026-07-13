import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotDecision } from "@/lib/bot";

// Server-only persistence for the bot_decisions table (0015_bot_decisions.sql) — the worker-side
// equivalent of the browser's local-only decision log
// (src/lib/state/bot-decision-log-context.tsx). Nothing in the running app calls this yet — no
// worker exists (Mission 7). See docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md for why
// worker-triggered decisions need a server home the browser's decision log never did.
export async function persistServerDecision(
  client: SupabaseClient,
  userId: string,
  decision: BotDecision,
  createdPaperTradeId: string | null,
): Promise<void> {
  const { error } = await client.from("bot_decisions").insert({
    user_id: userId,
    scan_id: decision.scanId,
    trigger_type: decision.triggerType,
    action_taken: decision.actionTaken,
    reason: decision.reason,
    decision,
    created_paper_trade_id: createdPaperTradeId,
    // Sprint 290 — required on BotDecision itself, so there is no code path that reaches this
    // insert without a real value already computed by runBotScan from this scan's own telemetry.
    data_provenance: decision.dataProvenance,
  });
  if (error) throw new Error(error.message);
}
