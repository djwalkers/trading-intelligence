import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaperTrade } from "@/lib/types";
import type { BotDecision } from "./types";
import type { BotExecutionContext } from "./bot-execution-context";
import { loadTradesForUser, addTradeForUser } from "@/lib/persistence/server-paper-trade-store";
import { persistServerDecision } from "@/lib/scheduler/server-bot-decision-store";

// Not called anywhere in the running app today — no worker exists yet (Mission 7). This is a
// ready-to-use BotExecutionContext implementation for whenever one does: pass it to
// executeBotScan() exactly as the browser's BotRunnerPanel does with its own context (built from
// usePaperTrades()/useBotDecisionLog()), and the identical risk pipeline runs — this time
// persisting through the service role instead of a browser session. Deliberately kept out of
// src/lib/bot/index.ts (the client-safe barrel): this module (and everything it imports) carries
// "server-only", so re-exporting it from the barrel would make importing @/lib/bot from a client
// component fail the build. Import this file directly by path from server-only call sites.
// See docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md.
export function createServerExecutionContext(
  client: SupabaseClient,
  userId: string,
): BotExecutionContext {
  let createdTradeId: string | null = null;

  return {
    loadTrades: () => loadTradesForUser(client, userId),
    async persistTrade(trade: PaperTrade) {
      await addTradeForUser(client, userId, trade);
      createdTradeId = trade.id;
    },
    persistDecision: (decision: BotDecision) =>
      persistServerDecision(client, userId, decision, createdTradeId),
  };
}
