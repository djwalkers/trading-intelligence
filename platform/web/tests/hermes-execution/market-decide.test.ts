import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Max-daily-trades risk counter fix. market-decide.ts requires live eToro demo credentials to run
// its own main() end to end, so this is a source-text regression check (the same convention other
// hard-to-integration-test CLI entry points in this codebase already use) — never a network call.

describe("market-decide.ts — dailyTradeCount source", () => {
  it("never sources portfolioRisk.dailyTradeCount from broker.getCompletedTrades()", async () => {
    const source = await fs.readFile("src/hermes-execution/market-decide.ts", "utf-8");
    expect(source).not.toMatch(/dailyTradeCount:\s*broker\.getCompletedTrades\(\)\.length/);
  });

  // Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota).
  // Both portfolioRisk blocks now call the store's own bounded countConfirmedEntriesForUtcDay method
  // — "same semantics in runtime and market-decide" — never the old
  // countConfirmedEntriesForUtcDay(await lifecycleStore.list(), ...) pattern that downloaded the
  // entire lifecycle table (harmless here, since this CLI's own store is in-memory, but the whole
  // point of this file is to mirror production's exact call shape).
  it("both portfolioRisk blocks use the store's own bounded countConfirmedEntriesForUtcDay method", async () => {
    const source = await fs.readFile("src/hermes-execution/market-decide.ts", "utf-8");
    expect(source).toMatch(/import\s*{\s*utcDayBoundaries\s*}/);
    const occurrences = source.match(/dailyTradeCount:\s*await lifecycleStore\.countConfirmedEntriesForUtcDay\(/g) ?? [];
    expect(occurrences).toHaveLength(2); // cycle 1 and cycle 2 — both relevant call sites
  });

  it("never calls lifecycleStore.list() to compute dailyTradeCount — the egress source this file must not reintroduce", async () => {
    const source = await fs.readFile("src/hermes-execution/market-decide.ts", "utf-8");
    expect(source).toMatch(/const lifecycleStore = new InMemoryTradeLifecycleStore\(\)/);
    expect(source).not.toMatch(/lifecycleStore\.list\(\)/);
  });
});
