import * as path from "node:path";
import { loadStrategyDefinitions } from "@/lib/hermes-execution/strategy-definitions/strategy-definition-registry";
import type { InstrumentCatalogueEntry } from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";
import { loadCandleDataset } from "@/lib/hermes-execution/backtest/backtest-dataset";
import { runBacktest, type BacktestRunConfig } from "@/lib/hermes-execution/backtest/backtest-result";
import { writeBacktestEvidence } from "@/lib/hermes-execution/backtest/backtest-persistence";

// Phase 2 — Deterministic Backtesting Foundation CLI. Standalone, read-only, deterministic: never
// connects to a broker, never calls eToro or any provider, never places/closes an order, never
// touches PM2, and never wires a backtest result into live execution or auto-promotes a strategy to
// APPROVED_FOR_DEMO. Reads only a local strategy definition file (via the existing Phase 1
// declarative registry) and a local, fixed candle dataset JSON file supplied via --data. No default
// filesystem mutation — evidence is written only when --output-dir is explicitly given, and never
// overwrites an existing file (see backtest-persistence.ts).
//
// Exit codes: 0 = success. 1 = an explicit, expected rejection (bad arguments, a malformed dataset
// or strategy, an unsupported instrument, an invalid backtest config) — every case this file itself
// detects and reports clearly. 2 = an unexpected crash (an exception this file did NOT anticipate),
// caught only by the top-level handler at the bottom of this file — kept distinct from 1 so a
// calling script can tell "this input was rejected for a known reason" apart from "something broke."

const STRATEGIES_DIR = process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), "strategies");

// Pre-commit review fix. Fixed, non-request-dependent set — the CLI's own `--instrument` argument
// is NEVER merged into this list (a prior version did, which meant ANY instrument name the caller
// asked for was automatically "known to the catalogue," completely defeating this boundary). An
// instrument outside this exact set can never pass catalogue validation, and is additionally
// rejected explicitly and immediately in `main()` below before any file is even read.
// Exported so Phase 3's research engine (strategy-research/) can build the IDENTICAL, honest
// catalogue stub — reused, never duplicated — whenever it loads a strategy through this same Phase 1
// registry for research purposes.
export const BACKTEST_CATALOGUE_INSTRUMENTS = ["BTC", "ETH", "SOL"] as const;

/**
 * Backtest-only, synthetic instrument catalogue stub — loadStrategyDefinitions (the existing Phase 1
 * registry) requires SOME InstrumentCatalogueEntry[] to cross-check a strategy's own
 * `supportedInstruments` against, but this CLI has no business reading live eToro capability
 * evidence (that would be a provider-adjacent dependency this deterministic, offline tool must never
 * have). Pre-commit review fix: every capability-shaped field here is now the honest, conservative
 * "not verified" value (`NOT_TESTED` / `false`) rather than a fabricated `READ_ONLY_VERIFIED` claim
 * — this stub's only real job is proving "this symbol exists at all," never asserting anything true
 * about live broker/demo/trading-universe eligibility, which this offline tool has no basis to know.
 */
export function buildBacktestCatalogueStub(): InstrumentCatalogueEntry[] {
  return BACKTEST_CATALOGUE_INSTRUMENTS.map((symbol) => ({
    symbol,
    displayName: null,
    brokerProvider: "etoro-demo",
    accountMode: "demo",
    brokerInstrumentId: null,
    instrumentTypeID: null,
    exchangeID: null,
    assetClass: "crypto",
    currency: null,
    currencySource: "unresolved",
    configuredInUniverse: false,
    readOnlyCapabilityStatus: "NOT_TESTED",
    stage4CapabilityStatus: "NOT_TESTED",
    effectiveCapabilityStatus: "NOT_TESTED",
    inConfiguredTradingUniverse: false,
    lastVerifiedAt: null,
    evidenceSchemaVersion: null,
    evidenceRunId: null,
    evidenceGitCommit: null,
    evidenceFile: null,
    classificationReasons: [
      "Backtest-only synthetic catalogue stub — deliberately NOT_TESTED/false: this offline tool has no live capability evidence and must never fabricate one. Membership in this fixed BTC/ETH/SOL list only lets a strategy's own schema validate; it is never evidence of real broker/demo/live trading eligibility.",
    ],
    limitations: ["Never derived from live capability evidence — backtest-only."],
    history: [],
    stage4LastTestedAt: null,
    stage4EvidenceRunId: null,
    stage4EvidenceGitCommit: null,
    stage4EvidenceFile: null,
    stage4ClassificationReasons: [],
    stage4History: [],
  }));
}

interface ParsedArgs {
  strategy?: string;
  version?: string;
  data?: string;
  instrument?: string;
  json: boolean;
  feeBps: number;
  slippageBps: number;
  startingCapital: number;
  outputDir?: string;
  splitAt?: string;
}

const FLAGS_WITH_VALUES = ["--strategy", "--version", "--data", "--instrument", "--fee-bps", "--slippage-bps", "--starting-capital", "--output-dir", "--split-at"] as const;
const KNOWN_FLAGS = new Set<string>([...FLAGS_WITH_VALUES, "--json"]);

type ArgParseResult = { ok: true; args: ParsedArgs } | { ok: false; json: boolean; detail: string };

/** Fails clearly (never silently ignores) on: an unrecognised flag, a flag missing its required
 * value, or a numeric flag whose value doesn't parse to a finite number — every one of these used to
 * be silently dropped or deferred to a much later, less specific downstream error. `--instrument` is
 * upper-cased here so `btc`/`Btc`/`BTC` are all treated identically, matching every catalogue/dataset
 * symbol's own uppercase convention. */
function parseArgs(argv: readonly string[]): ArgParseResult {
  const raw = new Map<string, string>();
  let json = false;
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!KNOWN_FLAGS.has(arg)) {
      unknown.push(arg);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return { ok: false, json, detail: `${arg} requires a value` };
    raw.set(arg, value);
  }
  if (unknown.length > 0) return { ok: false, json, detail: `unrecognised argument(s): ${unknown.join(", ")}` };

  function parseNumberFlag(flag: string, fallback: number): { ok: true; value: number } | { ok: false; detail: string } {
    const text = raw.get(flag);
    if (text === undefined) return { ok: true, value: fallback };
    const value = Number(text);
    if (!Number.isFinite(value)) return { ok: false, detail: `${flag} must be a valid finite number (got ${JSON.stringify(text)})` };
    return { ok: true, value };
  }

  const feeBps = parseNumberFlag("--fee-bps", 0);
  if (!feeBps.ok) return { ok: false, json, detail: feeBps.detail };
  const slippageBps = parseNumberFlag("--slippage-bps", 0);
  if (!slippageBps.ok) return { ok: false, json, detail: slippageBps.detail };
  const startingCapital = parseNumberFlag("--starting-capital", 10_000);
  if (!startingCapital.ok) return { ok: false, json, detail: startingCapital.detail };

  return {
    ok: true,
    args: {
      strategy: raw.get("--strategy"),
      version: raw.get("--version"),
      data: raw.get("--data"),
      instrument: raw.get("--instrument")?.toUpperCase(),
      json,
      feeBps: feeBps.value,
      slippageBps: slippageBps.value,
      startingCapital: startingCapital.value,
      outputDir: raw.get("--output-dir"),
      splitAt: raw.get("--split-at"),
    },
  };
}

function printUsage(): void {
  console.error("Usage: npm run strategy:backtest -- --strategy <STRATEGY_ID> --version <SEMVER> --data <path> --instrument <BTC|ETH|SOL> [--json]");
  console.error("  [--fee-bps <n>] [--slippage-bps <n>] [--starting-capital <n>] [--output-dir <path>] [--split-at <ISO-timestamp>]");
}

/** Every failure path funnels through here so `--json` gets a pure, parseable JSON object on
 * stdout (never plain text mixed in) exactly as reliably as a successful run does — a prior version
 * of this CLI only ever printed plain text to stderr on failure, even when `--json` was requested,
 * breaking that contract for any caller trying to parse this tool's output programmatically. Human
 * mode keeps using stderr for the error itself, consistent with warnings/errors never being written
 * to stdout in that mode either. */
function fail(json: boolean, stage: string, reason: string, detail: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, stage, reason, detail }, null, 2));
  } else {
    console.error(`[${stage}] ${reason}: ${detail}`);
  }
  process.exitCode = 1;
}

function formatMetrics(label: string, m: { tradeCount: number; winRate: number; netPnl: number; grossPnl: number; totalFees: number; totalSlippageCost: number; totalReturn: number; maxDrawdown: number; averageTrade: number; profitFactor: number | null; exposurePercentage: number; endingCapital: number }): string[] {
  return [
    `${label}`,
    `  Trades: ${m.tradeCount}  Win rate (net): ${(m.winRate * 100).toFixed(1)}%  Exposure: ${m.exposurePercentage.toFixed(1)}%`,
    `  Gross P&L: ${m.grossPnl.toFixed(2)}  Fees: ${m.totalFees.toFixed(2)}  Slippage: ${m.totalSlippageCost.toFixed(2)}  Net P&L: ${m.netPnl.toFixed(2)}`,
    `  Total return: ${(m.totalReturn * 100).toFixed(2)}%  Max drawdown (mark-to-market): ${(m.maxDrawdown * 100).toFixed(2)}%  Avg trade (net): ${m.averageTrade.toFixed(2)}  Profit factor (net): ${m.profitFactor === null ? "n/a (no losing trades)" : m.profitFactor.toFixed(2)}`,
    `  Ending capital: ${m.endingCapital.toFixed(2)}`,
  ];
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    fail(parsed.json, "args", "INVALID_ARGUMENTS", parsed.detail);
    printUsage();
    return;
  }
  const args = parsed.args;
  const generatedAt = new Date().toISOString();

  if (!args.strategy || !args.version || !args.data || !args.instrument) {
    fail(args.json, "args", "MISSING_ARGUMENTS", "Missing required argument(s): --strategy, --version, --data, and --instrument are all required.");
    printUsage();
    return;
  }

  if (!(BACKTEST_CATALOGUE_INSTRUMENTS as readonly string[]).includes(args.instrument)) {
    fail(args.json, "args", "UNSUPPORTED_INSTRUMENT", `--instrument must be one of ${BACKTEST_CATALOGUE_INSTRUMENTS.join(", ")} (got ${JSON.stringify(args.instrument)})`);
    return;
  }

  const datasetResult = await loadCandleDataset(args.data, () => generatedAt);
  if (!datasetResult.ok) {
    fail(args.json, "dataset", datasetResult.reason, datasetResult.detail);
    return;
  }

  const strategyLoad = await loadStrategyDefinitions(STRATEGIES_DIR, buildBacktestCatalogueStub(), { now: () => generatedAt });
  const record = strategyLoad.accepted.find((r) => r.document.strategyId === args.strategy && r.document.strategyVersion === args.version);
  if (!record) {
    const rejection = strategyLoad.rejected.find((r) => r.filePath.includes(args.strategy!) || r.filePath.includes(args.version!));
    fail(
      args.json,
      "strategy",
      "STRATEGY_NOT_FOUND",
      `Strategy "${args.strategy}" v${args.version} was not found as a valid, accepted strategy definition in ${STRATEGIES_DIR}.` +
        (rejection ? ` A related file was rejected [${rejection.reason}]: ${rejection.detail}` : ""),
    );
    return;
  }

  const config: BacktestRunConfig = {
    feeBps: args.feeBps,
    slippageBps: args.slippageBps,
    startingCapital: args.startingCapital,
    split: args.splitAt ? { splitAt: args.splitAt } : undefined,
  };

  const runResult = runBacktest(record.document, datasetResult.dataset, args.instrument, config, () => generatedAt);
  if (!runResult.ok) {
    fail(args.json, "backtest", runResult.reason, runResult.detail);
    return;
  }

  const result = runResult.result;
  // Strategy load-time warnings (e.g. "not yet READ_ONLY_VERIFIED") are surfaced alongside this
  // run's own — the catalogue stub above is deliberately honest/conservative, so this is expected
  // and routine, never a sign anything went wrong.
  result.warnings.push(...record.result.validationWarnings);

  let evidenceOutcome: { outcome: string; filePath?: string; detail?: string } | undefined;
  if (args.outputDir) {
    const written = await writeBacktestEvidence(args.outputDir, result);
    evidenceOutcome = written.outcome === "error" ? { outcome: written.outcome, detail: written.detail } : { outcome: written.outcome, filePath: written.filePath };
  }

  if (args.json) {
    console.log(JSON.stringify(evidenceOutcome ? { ok: true, ...result, evidence: evidenceOutcome } : { ok: true, ...result }, null, 2));
    return;
  }

  console.log("Deterministic Strategy Backtest — Phase 2 (read-only, offline)");
  console.log("================================================================");
  console.log("BACKTEST ONLY — NOT APPROVED FOR DEMO OR LIVE TRADING");
  console.log("");
  console.log(`Strategy: ${result.strategy.strategyId} v${result.strategy.strategyVersion} (hash ${result.strategy.strategyContentHash.slice(0, 12)}…)`);
  console.log(`Dataset: ${result.dataset.filePath} (hash ${result.dataset.datasetHash.slice(0, 12)}…)`);
  console.log(`Instrument: ${result.instrument}  Timeframe: ${result.timeframe}`);
  console.log(`Range: ${result.full.startTimestamp} .. ${result.full.endTimestamp} (${result.full.barCount} bars)`);
  console.log(`Run fingerprint: ${result.runFingerprint}`);
  console.log("");
  for (const line of formatMetrics("Full run", result.full)) console.log(line);
  if (result.inSample) {
    console.log("");
    for (const line of formatMetrics("In-sample", result.inSample)) console.log(line);
  }
  if (result.outOfSample) {
    console.log("");
    for (const line of formatMetrics("Out-of-sample", result.outOfSample)) console.log(line);
  }
  if (result.warnings.length > 0) {
    console.error("");
    console.error("Warnings:");
    for (const w of result.warnings) console.error(`  - ${w}`);
  }
  console.log("");
  console.log("Limitations:");
  for (const l of result.limitations) console.log(`  - ${l}`);
  if (evidenceOutcome) {
    console.log("");
    console.log(
      evidenceOutcome.outcome === "written"
        ? `Evidence written: ${evidenceOutcome.filePath}`
        : evidenceOutcome.outcome === "already-exists"
          ? `Evidence already exists for this exact run fingerprint (not overwritten): ${evidenceOutcome.filePath}`
          : `Evidence write failed: ${evidenceOutcome.detail}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Backtest run crashed unexpectedly:", error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
