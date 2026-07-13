import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasCompletedRefreshRun } from "./refresh-log-store";
import { getAllUniverseRows } from "./universe-store";

// Thrown when the caller asks for a summary before any refresh has ever completed — mirrors the
// same fail-safe distinction the worker relies on elsewhere: "never refreshed" (throw) is a
// different, more serious state than "refreshed, but nothing currently qualifies" (see
// eligibleWithCompleteMarketDataCount below, which is always 0 in Phase 2A — an honest,
// data-driven answer, not an error).
export class MarketUniverseNotReadyError extends Error {
  constructor() {
    super(
      "Market Universe has never been refreshed — run `npm run refresh-universe` before requesting a summary.",
    );
    this.name = "MarketUniverseNotReadyError";
  }
}

export interface MarketUniverseSummary {
  eligibleCount: number;
  // Rows that are eligible AND have every field a Strategy-Engine-shaped Instrument would need
  // genuinely populated (real price, change, day-range, AND volume). Volume is never available
  // from this phase's data source (Finnhub's basic quote has no volume field), so this is always 0
  // in Phase 2A, by honest design — not a bug, not a placeholder. No function in this phase
  // converts a market_universe_symbols row into an Instrument for Strategy Engine consumption;
  // that conversion is explicitly deferred to Phase 2B, once a bounded shortlist and a
  // volume-capable data source both exist. See docs/product/PHASE-2A-MARKET-UNIVERSE.md.
  eligibleWithCompleteMarketDataCount: number;
}

// Observability-only — used by the (default-off) MARKET_UNIVERSE_WORKER_ENABLED flag purely to log
// a summary line once per scan cycle. Never used to decide what the worker trades against; the
// worker's actual instrument list in Phase 2A is always src/lib/mock's static 5-symbol list,
// regardless of this flag or this function's result.
export async function getMarketUniverseSummary(client: SupabaseClient): Promise<MarketUniverseSummary> {
  const hasRun = await hasCompletedRefreshRun(client);
  if (!hasRun) throw new MarketUniverseNotReadyError();

  const rows = await getAllUniverseRows(client);
  const eligibleCount = rows.filter((row) => row.isEligible).length;

  // No volume column exists yet at all — Finnhub's basic quote never returns it, so there was
  // nothing genuine to persist (see price-eligibility.ts). "Complete" therefore can never be true
  // in Phase 2A: this is always 0, by honest design, not computed from a condition that happens to
  // evaluate false. Phase 2B, once a volume-capable data source and its column exist, replaces this
  // constant with a real per-row completeness check.
  const eligibleWithCompleteMarketDataCount = 0;

  return { eligibleCount, eligibleWithCompleteMarketDataCount };
}
