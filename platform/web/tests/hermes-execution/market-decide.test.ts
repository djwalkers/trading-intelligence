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

  it("both portfolioRisk blocks use the shared countConfirmedEntriesForUtcDay helper", async () => {
    const source = await fs.readFile("src/hermes-execution/market-decide.ts", "utf-8");
    expect(source).toMatch(/import\s*{\s*countConfirmedEntriesForUtcDay/);
    const occurrences = source.match(/dailyTradeCount:\s*countConfirmedEntriesForUtcDay\(/g) ?? [];
    expect(occurrences).toHaveLength(2); // cycle 1 and cycle 2 — both relevant call sites
  });

  it("keeps the durable lifecycle store reference so dailyTradeCount can be recomputed each cycle", async () => {
    const source = await fs.readFile("src/hermes-execution/market-decide.ts", "utf-8");
    expect(source).toMatch(/const lifecycleStore = new InMemoryTradeLifecycleStore\(\)/);
    expect(source).toMatch(/await lifecycleStore\.list\(\)/);
  });
});
