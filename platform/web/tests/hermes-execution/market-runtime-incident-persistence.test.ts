import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_MARKET_DATA_INCIDENT_STATE_PATH } from "@/lib/hermes-execution/runtime/market-data-incident-tracker";

// Production-readiness review — market-data incident deduplication fix. Guards against exactly the
// defect this review found: the production bootstrap (market-runtime.ts) constructed TradingRuntime
// without ever passing `marketDataIncidentStatePath`, silently leaving the real VPS runtime
// IN_MEMORY_ONLY despite the tracker's own durable-persistence design existing and being fully
// tested in isolation. main() itself is not unit-tested here (it constructs real Supabase clients,
// brokers, and PM2-facing signal handlers with no existing mocking harness in this codebase) — this
// is a fast, deterministic static check on the bootstrap's own source, mirroring
// strategy-catalogue-cli.test.ts's own established "assert on source text" convention for a CLI
// entrypoint that is otherwise impractical to exercise end-to-end in a unit test.

describe("market-runtime.ts — durable market-data incident persistence wiring", () => {
  it("imports the shared DEFAULT_MARKET_DATA_INCIDENT_STATE_PATH constant and passes it to TradingRuntime", async () => {
    const source = await fs.readFile("src/hermes-execution/market-runtime.ts", "utf-8");
    expect(source).toMatch(/import\s*\{\s*DEFAULT_MARKET_DATA_INCIDENT_STATE_PATH\s*\}\s*from\s*"@\/lib\/hermes-execution\/runtime\/market-data-incident-tracker"/);
    expect(source).toMatch(/marketDataIncidentStatePath/);
    // Never a bare inline literal path — always sourced from the one shared constant every other
    // consumer (and this test) reads, so a future rename/relocation can't silently desync them.
    expect(source).not.toMatch(/marketDataIncidentStatePath:\s*["'`]/);
  });

  it("logs the resolved persistence mode (DURABLE/IN_MEMORY_ONLY) so an operator can see it at startup", async () => {
    const source = await fs.readFile("src/hermes-execution/market-runtime.ts", "utf-8");
    expect(source).toMatch(/DURABLE/);
    expect(source).toMatch(/IN_MEMORY_ONLY/);
  });

  it("resolves under the existing stable .data/hermes-execution/ runtime data directory, matching the audit log and daily-summary state file convention", () => {
    expect(DEFAULT_MARKET_DATA_INCIDENT_STATE_PATH).toMatch(/[/\\]\.data[/\\]hermes-execution[/\\]market-data-incident-state\.json$/);
  });
});
