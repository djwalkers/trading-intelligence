import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArchiveLocation, computeSha256Hex, generateMonthRange, INSTRUMENT_TO_BINANCE_SYMBOL, RESEARCH_INSTRUMENTS, type BinanceSymbol } from "@/lib/hermes-execution/dataset-intake/binance-archive";
import { validateDatasetManifestEntry, checkNoDuplicateManifestEntries } from "@/lib/hermes-execution/strategy-research/dataset-manifest";
import { buildBinanceMonthCsv, buildZipBuffer } from "./dataset-intake/binance-fixtures";

// Phase 4 — Historical Dataset Intake — Binance acquisition CLI. `fetch` is ALWAYS mocked; this
// suite never makes a real network call. Never calls eToro/any broker, never touches PM2, never
// wires anything into live execution, never promotes a strategy, never runs the research plan.

const EXAMPLE_PLAN_PATH = path.join("strategies", "research-plans", "CRYPTO_EMA_TREND_V1_BASELINE_NEIGHBOURHOOD__1.0.0.json");

function checksumText(hash: string, fileName: string): string {
  return `${hash}  ${fileName}\n`;
}
function jsonResponse(body: Buffer | string, status = 200): Response {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  return new Response(new Uint8Array(buffer), { status });
}

/** Serves every checksum/zip URL for the given month range across all three symbols from an
 * in-memory fixture — never touches the network. Uses MICROSECONDS from 2025-01 onward (the real
 * Binance transition) and MILLISECONDS before, so the full pipeline test exercises both units and
 * the unit-transition boundary in one run. */
function buildFetchMock(months: readonly string[]): ReturnType<typeof vi.fn> {
  const bySymbolMonth = new Map<string, Buffer>();
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"] satisfies BinanceSymbol[]) {
    for (const month of months) {
      const [year, mo] = month.split("-").map(Number) as [number, number];
      const unit = month >= "2025-01" ? "MICROSECONDS" : "MILLISECONDS";
      const csv = buildBinanceMonthCsv(year!, mo!, unit);
      const zip = buildZipBuffer(`${symbol}-1h-${month}.csv`, Buffer.from(csv));
      bySymbolMonth.set(`${symbol}:${month}`, zip);
    }
  }
  return vi.fn(async (url: string) => {
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"] satisfies BinanceSymbol[]) {
      for (const month of months) {
        const location = buildArchiveLocation(symbol, month);
        const zip = bySymbolMonth.get(`${symbol}:${month}`)!;
        if (url === location.zipUrl) return jsonResponse(zip);
        if (url === location.checksumUrl) return jsonResponse(checksumText(computeSha256Hex(zip), location.zipFileName));
      }
    }
    throw new Error(`unmocked URL requested: ${url}`);
  });
}

describe("dataset-binance-download-cli", () => {
  let outputRoot: string;
  beforeEach(async () => {
    outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "binance-cli-test-"));
    vi.resetModules();
  });
  afterEach(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("never imports a broker/execution/risk/lifecycle/approval/reconciliation/telegram/provider module", async () => {
    const source = await fs.readFile("src/hermes-execution/dataset-binance-download-cli.ts", "utf-8");
    expect(source).not.toMatch(/broker-factory|paper-broker|etoro-demo-broker|risk-engine|trade-lifecycle|trade-candidate|placeMarketOrder|closePosition|broker-etoro-smoke|telegram|trading-runtime|market-runtime|market-data-provider/i);
  });

  it("rejects an unrecognised flag", async () => {
    process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2023-01", "--output-root", outputRoot, "--bogus", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("--bogus");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects an unsafe --output-root pointing at this project's own source directory", async () => {
    process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2023-01", "--output-root", "src", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.reason).toBe("UNSAFE_OUTPUT_ROOT");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects an empty or whitespace-only --output-root", async () => {
    process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2023-01", "--output-root", "   ", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.reason).toBe("UNSAFE_OUTPUT_ROOT");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("rejects a range that would include 2026 data", async () => {
    process.argv = ["node", "cli.ts", "--from", "2025-06", "--to", "2026-01", "--output-root", outputRoot, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
      await main();
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.detail).toContain("2025-12");
    } finally {
      logSpy.mockRestore();
      process.exitCode = 0;
    }
  });

  it("--dry-run lists exact intended URLs and performs zero network operations", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("--dry-run must never call fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2023-02", "--output-root", outputRoot, "--dry-run", "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
      await main();
      expect(process.exitCode).not.toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.dryRun).toBe(true);
      expect(parsed.locations).toHaveLength(6); // 3 symbols x 2 months
      expect(parsed.locations[0].zipUrl).toContain("https://data.binance.vision/");
    } finally {
      logSpy.mockRestore();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.readdir(outputRoot).catch(() => [])).toEqual([]); // no filesystem side effect either
  });

  it("downloads a partial range and cleanly skips stage 2 pending full coverage — no crash, exit 0", async () => {
    const months = generateMonthRange("2023-01", "2023-01");
    if (!months.ok) throw new Error("bad fixture range");
    const fetchMock = buildFetchMock(months.months);
    vi.stubGlobal("fetch", fetchMock);
    process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2023-01", "--output-root", outputRoot, "--json"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
      await main();
      expect(process.exitCode).not.toBe(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      expect(parsed.stage2.skipped).toBe(true);
      expect(parsed.stage2.missingOrCorrupt.length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
    // Exactly this run's own 3 symbols x 1 month x 2 files (zip+checksum) were requested — never the
    // full 36-month range, and never re-requested for months this run didn't ask for.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it(
    "full pipeline: downloads, verifies, assembles, and validates all six datasets across the millisecond/microsecond unit transition, and generates a valid Phase 3 manifest without touching the committed example plan",
    async () => {
      const monthsResult = generateMonthRange("2023-01", "2025-12");
      if (!monthsResult.ok) throw new Error("bad fixture range");
      const fetchMock = buildFetchMock(monthsResult.months);
      vi.stubGlobal("fetch", fetchMock);

      const planBefore = await fs.readFile(EXAMPLE_PLAN_PATH, "utf-8");

      process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2025-12", "--output-root", outputRoot, "--json"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let parsed: Record<string, unknown>;
      try {
        const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
        await main();
        expect(process.exitCode).not.toBe(1);
        parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      } finally {
        logSpy.mockRestore();
      }
      expect(parsed.ok).toBe(true);

      const planAfter = await fs.readFile(EXAMPLE_PLAN_PATH, "utf-8");
      expect(planAfter).toBe(planBefore); // never modified automatically

      const expectedCounts: Record<string, number> = { IN_SAMPLE: 731 * 24, OUT_OF_SAMPLE: 365 * 24 };
      for (const instrument of RESEARCH_INSTRUMENTS) {
        for (const role of ["IN_SAMPLE", "OUT_OF_SAMPLE"] as const) {
          const filePath = path.join(outputRoot, "prepared", `${instrument}_${role}_1h.json`);
          const document = JSON.parse(await fs.readFile(filePath, "utf-8"));
          expect(document.schemaVersion).toBe(1);
          expect(document.instrument).toBe(instrument);
          expect(document.timeframe).toBe("1h");
          expect(document.candles).toHaveLength(expectedCounts[role]!);
          expect(document.source).toBe(`BINANCE_SPOT_${INSTRUMENT_TO_BINANCE_SYMBOL[instrument]}`);
        }
      }

      const manifestPath = path.join(outputRoot, "manifests", "research-plan-manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
      expect(manifest).toHaveLength(6);
      const errors = manifest.flatMap((entry: unknown, i: number) => validateDatasetManifestEntry(entry, `[${i}]`));
      expect(errors).toEqual([]);
      expect(checkNoDuplicateManifestEntries(manifest).ok).toBe(true);

      const report = JSON.parse(await fs.readFile(path.join(outputRoot, "manifests", "acquisition-report.json"), "utf-8"));
      expect(report.provider).toBe("Binance public archive");
      expect(report.quoteAsset).toBe("USDT");
      expect(report.datasets).toHaveLength(6);

      const placeholderReplacement = JSON.parse(await fs.readFile(path.join(outputRoot, "manifests", "plan-placeholder-replacement.json"), "utf-8"));
      expect(placeholderReplacement.entries).toHaveLength(6);
    },
    20_000,
  );

  it(
    "acquisition report's sourceArchives includes archives downloaded in an earlier, separate invocation — never scoped to only the final run's own downloads",
    async () => {
      const allMonths = generateMonthRange("2023-01", "2025-12");
      if (!allMonths.ok) throw new Error("bad fixture range");
      const remainingMonths = allMonths.months.filter((m) => m !== "2023-01");

      // First invocation: download only 2023-01 (all three symbols), well short of the full 108
      // requirement — stage 2 is expected to be skipped.
      vi.stubGlobal("fetch", buildFetchMock(["2023-01"]));
      process.argv = ["node", "cli.ts", "--from", "2023-01", "--to", "2023-01", "--output-root", outputRoot, "--json"];
      {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
          await main();
          expect(process.exitCode).not.toBe(1);
        } finally {
          logSpy.mockRestore();
        }
      }
      vi.unstubAllGlobals();
      vi.resetModules();

      // Second, separate invocation: download the remaining 35 months. Combined with the FIRST
      // invocation's own cached (and now unrequested) 2023-01 archives, this completes the full
      // 108-archive requirement and triggers stage 2.
      vi.stubGlobal("fetch", buildFetchMock(remainingMonths));
      process.argv = ["node", "cli.ts", "--from", "2023-02", "--to", "2025-12", "--output-root", outputRoot, "--json"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let parsed: { stage2: { acquisitionReport: { sourceArchives: { instrument: string; month: string; zipFileName: string; sha256: string }[] } } };
      try {
        const { main } = await import("@/hermes-execution/dataset-binance-download-cli");
        await main();
        expect(process.exitCode).not.toBe(1);
        parsed = JSON.parse(String(logSpy.mock.calls[0]![0]));
      } finally {
        logSpy.mockRestore();
      }

      const sourceArchives = parsed.stage2.acquisitionReport.sourceArchives;
      expect(sourceArchives).toHaveLength(108);
      const januaryEntries = sourceArchives.filter((a) => a.month === "2023-01");
      expect(januaryEntries).toHaveLength(3); // BTC/ETH/SOL — downloaded only by the FIRST invocation
      for (const entry of januaryEntries) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    },
    20_000,
  );

  it("the top-level crash handler is JSON-aware", async () => {
    const source = await fs.readFile("src/hermes-execution/dataset-binance-download-cli.ts", "utf-8");
    expect(source).toMatch(/main\(\)\.catch\(/);
    expect(source).toMatch(/process\.argv\.includes\(["']--json["']\)/);
    expect(source).toMatch(/process\.exitCode = 2/);
  });
});
