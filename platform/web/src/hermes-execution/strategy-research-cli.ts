import * as path from "node:path";
import { buildBacktestCatalogueStub } from "./strategy-backtest-cli";
import { runResearch } from "@/lib/hermes-execution/strategy-research/research-engine";
import { writeResearchEvidence } from "@/lib/hermes-execution/strategy-research/research-persistence";
import { RESEARCH_DISCLAIMER } from "@/lib/hermes-execution/strategy-research/research-result";
import { MAX_EXPERIMENT_VARIANTS_HARD_CAP } from "@/lib/hermes-execution/strategy-research/experiment-matrix";

// Phase 3 — Strategy Research Workflow CLI. Standalone, read-only, deterministic: never connects to
// a broker, never calls eToro or any provider, never places/closes an order, never touches PM2, and
// never wires a research result into live execution or promotes a strategy's status. Reads only a
// local research plan JSON file (via --plan) plus whatever local strategy/dataset files that plan
// itself references. No default filesystem mutation — evidence is written only when --output-dir is
// explicitly given, and never overwrites an existing file (see research-persistence.ts).
//
// Exit codes: 0 = the research plan was validly executed to a real verdict — PASS, FAIL, or
// INCONCLUSIVE all count as success here; a FAIL research outcome is evidence, never a CLI crash.
// 1 = an explicit, expected rejection: bad arguments, an invalid plan/strategy/dataset, or an
// INVALID research outcome (evidence itself could not be produced). 2 = an unexpected crash.

const STRATEGIES_DIR = process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), "strategies");

interface ParsedArgs {
  plan?: string;
  outputDir?: string;
  json: boolean;
  maxExperiments?: number;
  /** Accepted for forward-compatibility and to document intent explicitly, but not itself a
   * separate behavioural switch today: `runResearch` (research-engine.ts) already stops at the
   * FIRST invalid stage — a malformed plan, an unfound strategy, a dataset hash mismatch — before
   * any experiment ever runs, exactly the "fail fast on invalid input" behaviour this flag names.
   * It never affects a FAIL/INCONCLUSIVE research OUTCOME, which is always valid, complete evidence
   * this CLI reports in full regardless of this flag — per requirement 11's own explicit "only for
   * invalid input, not failed strategy results." */
  failFast: boolean;
}

const FLAGS_WITH_VALUES = ["--plan", "--output-dir", "--max-experiments"] as const;
const KNOWN_FLAGS = new Set<string>([...FLAGS_WITH_VALUES, "--json", "--fail-fast"]);

type ArgParseResult = { ok: true; args: ParsedArgs } | { ok: false; json: boolean; detail: string };

function parseArgs(argv: readonly string[]): ArgParseResult {
  const raw = new Map<string, string>();
  let json = false;
  let failFast = false;
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
    if (arg === "--fail-fast") {
      failFast = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return { ok: false, json, detail: `${arg} requires a value` };
    raw.set(arg, value);
  }
  if (unknown.length > 0) return { ok: false, json, detail: `unrecognised argument(s): ${unknown.join(", ")}` };

  let maxExperiments: number | undefined;
  if (raw.has("--max-experiments")) {
    const value = Number(raw.get("--max-experiments"));
    if (!Number.isInteger(value) || value < 1) return { ok: false, json, detail: `--max-experiments must be a positive integer (got ${JSON.stringify(raw.get("--max-experiments"))})` };
    if (value > MAX_EXPERIMENT_VARIANTS_HARD_CAP) {
      return { ok: false, json, detail: `--max-experiments may only LOWER the built-in cap of ${MAX_EXPERIMENT_VARIANTS_HARD_CAP}, never raise it (got ${value})` };
    }
    maxExperiments = value;
  }

  return { ok: true, args: { plan: raw.get("--plan"), outputDir: raw.get("--output-dir"), json, maxExperiments, failFast } };
}

function printUsage(): void {
  console.error("Usage: npm run strategy:research -- --plan <research-plan.json> [--json] [--output-dir <path>] [--max-experiments <n>] [--fail-fast]");
}

function fail(json: boolean, stage: string, reason: string, detail: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, stage, reason, detail }, null, 2));
  } else {
    console.error(`[${stage}] ${reason}: ${detail}`);
  }
  process.exitCode = 1;
}

function formatSegment(label: string, m: { tradeCount: number; totalReturn: number; maxDrawdown: number; winRate: number } | undefined): string {
  if (!m) return `  ${label}: n/a`;
  return `  ${label}: trades=${m.tradeCount} return=${(m.totalReturn * 100).toFixed(2)}% drawdown=${(m.maxDrawdown * 100).toFixed(2)}% winRate=${(m.winRate * 100).toFixed(1)}%`;
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    fail(parsed.json, "args", "INVALID_ARGUMENTS", parsed.detail);
    printUsage();
    return;
  }
  const args = parsed.args;
  if (!args.plan) {
    fail(args.json, "args", "MISSING_ARGUMENTS", "Missing required argument: --plan");
    printUsage();
    return;
  }

  const output = await runResearch({
    planPath: args.plan,
    strategiesDir: STRATEGIES_DIR,
    catalogueEntries: buildBacktestCatalogueStub(),
    maxExperimentsOverride: args.maxExperiments,
  });

  if (!output.ok) {
    fail(args.json, output.stage, output.reason, output.detail);
    return;
  }

  const result = output.result;
  let evidenceOutcome: { outcome: string; filePath?: string; detail?: string } | undefined;
  if (args.outputDir) {
    const written = await writeResearchEvidence(args.outputDir, result);
    evidenceOutcome = written.outcome === "error" ? { outcome: written.outcome, detail: written.detail } : { outcome: written.outcome, filePath: written.filePath };
  }

  // A FAIL/INCONCLUSIVE outcome is valid, complete evidence — exit 0, same as PASS. `result.outcome`
  // is typed `ResolvedResearchOutcome` (PASS/FAIL/INCONCLUSIVE only) precisely because a successfully
  // produced `ResearchResult` can never carry `INVALID` — that case is already handled above via
  // `output.ok === false` (evidence itself could not be produced), never reachable here.

  if (args.json) {
    console.log(JSON.stringify(evidenceOutcome ? { ok: true, ...result, evidence: evidenceOutcome } : { ok: true, ...result }, null, 2));
    return;
  }

  console.log("Deterministic Strategy Research Workflow — Phase 3 (read-only, offline)");
  console.log("=========================================================================");
  console.log(RESEARCH_DISCLAIMER);
  console.log("");
  console.log(`Research plan: ${result.plan.researchPlanId} v${result.plan.researchPlanVersion}`);
  console.log(`Strategy: ${result.strategy.strategyId} v${result.strategy.strategyVersion} (hash ${result.strategy.strategyContentHash.slice(0, 12)}…)`);
  console.log(`Instruments: ${[...new Set(result.datasets.map((d) => d.instrument))].join(", ")}`);
  for (const dataset of result.datasets) console.log(`  Dataset [${dataset.instrument}/${dataset.role}]: ${dataset.filePath} (hash ${dataset.datasetHash.slice(0, 12)}…)`);
  console.log(`Experiments: ${result.variants.length} variant(s) (including baseline)`);
  console.log(`Research fingerprint: ${result.researchFingerprint}`);
  console.log("");
  console.log("Baseline:");
  for (const instrumentResult of result.baseline.perInstrument) {
    console.log(`  ${instrumentResult.instrument} [${instrumentResult.mode}]:`);
    if (instrumentResult.full) console.log(`  ${formatSegment("full", instrumentResult.full)}`);
    if (instrumentResult.inSample) console.log(`  ${formatSegment("in-sample", instrumentResult.inSample)}`);
    if (instrumentResult.outOfSample) console.log(`  ${formatSegment("out-of-sample", instrumentResult.outOfSample)}`);
  }
  console.log("");
  console.log(`Acceptable variants: ${result.aggregate.acceptableVariantCount}/${result.aggregate.variantCount} (${result.aggregate.acceptableVariantPercentage.toFixed(1)}%; ${result.aggregate.evaluableVariantCount} evaluable)`);
  console.log("");
  console.log("Mandatory criteria:");
  for (const evaluation of result.criterionEvaluations) {
    console.log(`  ${evaluation.satisfied ? "PASS" : "FAIL"}  ${evaluation.detail}`);
  }
  console.log("");
  console.log(`Outcome: ${result.outcome}`);
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
          ? `Evidence already exists for this exact research fingerprint (not overwritten): ${evidenceOutcome.filePath}`
          : `Evidence write failed: ${evidenceOutcome.detail}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    // Must stay JSON-aware even on an unexpected crash — a `--json` caller parsing stdout should
    // never have to fall back to scraping stderr text just because this path is the unhappy one.
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, stage: "execution", reason: "UNEXPECTED_ERROR", detail }, null, 2));
    } else {
      console.error("Research run crashed unexpectedly:", detail);
    }
    process.exitCode = 2;
  });
}
