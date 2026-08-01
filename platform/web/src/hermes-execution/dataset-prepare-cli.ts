import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { SUPPORTED_MARKET_TIMEFRAMES, type MarketTimeframe } from "@/lib/hermes-execution/market-data/candle-validation";
import { SUPPORTED_TIMEFRAMES, type SupportedTimeframe } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";
import { coerceTimestampToUtcIso, isSupportedTimezoneAssumption, prepareDataset, SUPPORTED_INPUT_FORMATS, type InputFormat } from "@/lib/hermes-execution/dataset-intake/dataset-intake";
import { appendManifestEntry } from "@/lib/hermes-execution/dataset-intake/manifest-writer";
import type { DatasetManifestEntry, DatasetRole } from "@/lib/hermes-execution/strategy-research/dataset-manifest";

// Phase 4 — Historical Dataset Intake CLI. Standalone, offline, read-only-of-the-live-system:
// reads exactly one local input file (`--input`) the caller already obtained, never fetches
// anything, never calls eToro or any provider, never touches PM2, never wires anything into the
// live runtime, and never promotes a strategy. Its only filesystem writes are the local `--output`
// dataset file and, optionally, the local `--manifest-output` manifest file — both explicit,
// caller-directed paths.
//
// Exit codes: 0 = the input converted and validated successfully (and wrote successfully, if a
// write was requested). 1 = an explicit, expected rejection — bad arguments, a validation failure,
// an output path that already exists, or a manifest conflict. 2 = an unexpected crash.

const DATASET_ROLES: readonly DatasetRole[] = ["IN_SAMPLE", "OUT_OF_SAMPLE", "FULL_HISTORY", "STRESS_PERIOD"];

interface ParsedArgs {
  input: string;
  format: InputFormat;
  instrument: string;
  timeframe: MarketTimeframe;
  source: string;
  timezone: string;
  output?: string;
  json: boolean;
  dryRun: boolean;
  manifestOutput?: string;
  role?: DatasetRole;
  dateFrom?: string;
  dateTo?: string;
}

const FLAGS_WITH_VALUES = ["--input", "--format", "--instrument", "--timeframe", "--source", "--timezone", "--output", "--manifest-output", "--role", "--date-from", "--date-to"] as const;
const KNOWN_FLAGS = new Set<string>([...FLAGS_WITH_VALUES, "--json", "--dry-run"]);

type ArgParseResult = { ok: true; args: ParsedArgs } | { ok: false; json: boolean; detail: string };

function parseArgs(argv: readonly string[]): ArgParseResult {
  const raw = new Map<string, string>();
  let json = false;
  let dryRun = false;
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
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return { ok: false, json, detail: `${arg} requires a value` };
    raw.set(arg, value);
  }
  if (unknown.length > 0) return { ok: false, json, detail: `unrecognised argument(s): ${unknown.join(", ")}` };

  const missing = ["--input", "--format", "--instrument", "--timeframe", "--source", "--timezone"].filter((f) => !raw.has(f));
  if (missing.length > 0) return { ok: false, json, detail: `missing required argument(s): ${missing.join(", ")}` };

  const format = raw.get("--format")!;
  if (!(SUPPORTED_INPUT_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, json, detail: `--format must be one of ${SUPPORTED_INPUT_FORMATS.join(", ")} (got ${JSON.stringify(format)})` };
  }

  const timeframe = raw.get("--timeframe")!;
  if (!(SUPPORTED_MARKET_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    return { ok: false, json, detail: `--timeframe must be one of ${SUPPORTED_MARKET_TIMEFRAMES.join(", ")} (got ${JSON.stringify(timeframe)})` };
  }

  const timezone = raw.get("--timezone")!;
  if (!isSupportedTimezoneAssumption(timezone)) {
    return { ok: false, json, detail: `--timezone must be "UTC" or a fixed offset like "+02:00"/"-05:00" (got ${JSON.stringify(timezone)}) — named zones (e.g. "America/New_York") are not supported` };
  }

  const instrument = raw.get("--instrument")!.trim();
  if (instrument.length === 0) return { ok: false, json, detail: "--instrument must be a non-empty string" };
  const source = raw.get("--source")!.trim();
  if (source.length === 0) return { ok: false, json, detail: "--source must be a non-empty string" };

  let role: DatasetRole | undefined;
  if (raw.has("--role")) {
    const roleValue = raw.get("--role")!;
    if (!DATASET_ROLES.includes(roleValue as DatasetRole)) {
      return { ok: false, json, detail: `--role must be one of ${DATASET_ROLES.join(", ")} (got ${JSON.stringify(roleValue)})` };
    }
    role = roleValue as DatasetRole;
  }
  if (raw.has("--manifest-output") && role === undefined) {
    return { ok: false, json, detail: "--manifest-output requires --role to also be supplied" };
  }
  if (raw.has("--output") && raw.has("--manifest-output") && path.resolve(raw.get("--output")!) === path.resolve(raw.get("--manifest-output")!)) {
    return { ok: false, json, detail: "--output and --manifest-output must not be the same path — the dataset file and the manifest file are different documents" };
  }

  // Parsed through the SAME explicit, non-guessing timezone handling as every candle timestamp
  // (never raw `Date.parse`, which for a naive date-time string silently falls back to the HOST
  // MACHINE's own local timezone — exactly the kind of environment-dependent guess this CLI exists
  // to avoid) — see coerceTimestampToUtcIso's own doc comment.
  let dateFrom: string | undefined;
  const rawDateFrom = raw.get("--date-from");
  if (rawDateFrom !== undefined) {
    const coerced = coerceTimestampToUtcIso(rawDateFrom, timezone);
    if (coerced === undefined) return { ok: false, json, detail: `--date-from must be a parseable ISO-8601 date-time (got ${JSON.stringify(rawDateFrom)})` };
    dateFrom = coerced;
  }
  let dateTo: string | undefined;
  const rawDateTo = raw.get("--date-to");
  if (rawDateTo !== undefined) {
    const coerced = coerceTimestampToUtcIso(rawDateTo, timezone);
    if (coerced === undefined) return { ok: false, json, detail: `--date-to must be a parseable ISO-8601 date-time (got ${JSON.stringify(rawDateTo)})` };
    dateTo = coerced;
  }
  if (dateFrom !== undefined && dateTo !== undefined && Date.parse(dateFrom) >= Date.parse(dateTo)) {
    return { ok: false, json, detail: "--date-from must be strictly before --date-to" };
  }

  return {
    ok: true,
    args: {
      input: raw.get("--input")!,
      format: format as InputFormat,
      instrument,
      timeframe: timeframe as MarketTimeframe,
      source,
      timezone,
      output: raw.get("--output"),
      json,
      dryRun,
      manifestOutput: raw.get("--manifest-output"),
      role,
      dateFrom,
      dateTo,
    },
  };
}

function printUsage(): void {
  console.error(
    "Usage: npm run dataset:prepare -- --input <file> --format csv|json --instrument <SYMBOL> --timeframe <tf> --source <label> --timezone UTC|+HH:MM [--output <file>] [--json] [--dry-run] [--manifest-output <file>] [--role IN_SAMPLE|OUT_OF_SAMPLE|FULL_HISTORY|STRESS_PERIOD] [--date-from <iso>] [--date-to <iso>]",
  );
}

function fail(json: boolean, stage: string, reason: string, detail: string, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, stage, reason, detail, ...extra }, null, 2));
  } else {
    console.error(`[${stage}] ${reason}: ${detail}`);
  }
  process.exitCode = 1;
}

/** Same atomic create-only technique as backtest-persistence.ts/research-persistence.ts: a unique
 * temp file (fsynced) hard-linked to the destination — `fs.link` fails with EEXIST if the
 * destination already exists, which this CLI treats as an explicit rejection (Phase 4 never
 * supports `--overwrite`), never a silent overwrite and never a silent no-op. */
async function writeCreateOnly(filePath: string, content: string): Promise<{ ok: true } | { ok: false; reason: "OUTPUT_ALREADY_EXISTS" | "WRITE_ERROR"; detail: string }> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.tmp-${randomUUID()}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(tempPath, filePath);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { ok: false, reason: "OUTPUT_ALREADY_EXISTS", detail: `${filePath} already exists — Phase 4 never overwrites; choose a different --output path` };
      }
      throw error;
    }
  } catch (error) {
    return { ok: false, reason: "WRITE_ERROR", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    fail(parsed.json, "args", "INVALID_ARGUMENTS", parsed.detail);
    printUsage();
    return;
  }
  const args = parsed.args;
  const now = () => new Date().toISOString();

  let rawText: string;
  try {
    rawText = await fs.readFile(args.input, "utf-8");
  } catch (error) {
    fail(args.json, "input", "READ_ERROR", error instanceof Error ? error.message : String(error));
    return;
  }

  const result = prepareDataset({
    rawText,
    format: args.format,
    instrument: args.instrument,
    timeframe: args.timeframe,
    source: args.source,
    timezone: args.timezone,
    inputFileLabel: path.basename(args.input),
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    importedAt: now(),
  });

  if (!result.ok) {
    fail(args.json, "validation", result.reason, result.detail, { report: result.report });
    return;
  }

  let outputOutcome: { outcome: string; filePath?: string; detail?: string } | undefined;
  if (args.output && !args.dryRun) {
    const written = await writeCreateOnly(args.output, JSON.stringify(result.document, null, 2));
    if (!written.ok) {
      fail(args.json, "output", written.reason, written.detail, { report: result.report });
      return;
    }
    outputOutcome = { outcome: "written", filePath: args.output };
  }

  // From here on, `outputOutcome` (if set) reflects a dataset file that has ALREADY been written
  // successfully to disk — a later manifest failure never rolls it back (the dataset file is still
  // perfectly valid on its own), so every manifest-stage failure below explicitly reports it, never
  // leaving the operator to wonder whether --output actually happened before the manifest step failed.
  let manifestOutcome: { outcome: string; filePath?: string; entries?: unknown; detail?: string } | undefined;
  if (args.manifestOutput && args.role) {
    if (!(SUPPORTED_TIMEFRAMES as readonly string[]).includes(args.timeframe)) {
      fail(
        args.json,
        "manifest",
        "UNSUPPORTED_TIMEFRAME_FOR_MANIFEST",
        `Phase 3 research plans currently only support timeframe(s) ${SUPPORTED_TIMEFRAMES.join(", ")} — a manifest entry for "${args.timeframe}" would be rejected by dataset-manifest.ts's own validator, so it is never generated here`,
        { report: result.report, output: outputOutcome },
      );
      return;
    }
    const entry: DatasetManifestEntry = {
      instrument: args.instrument,
      timeframe: args.timeframe as SupportedTimeframe,
      datasetFile: args.output ?? args.input,
      expectedDatasetHash: result.datasetHash,
      startTimestamp: result.document.candles[0]!.timestamp,
      endTimestamp: result.document.candles[result.document.candles.length - 1]!.timestamp,
      role: args.role,
    };
    const merged = await appendManifestEntry(args.manifestOutput, entry, args.dryRun);
    if (!merged.ok) {
      fail(args.json, "manifest", merged.reason, merged.detail, { report: result.report, output: outputOutcome });
      return;
    }
    manifestOutcome = { outcome: args.dryRun ? "dry-run" : "written", filePath: args.manifestOutput, entries: merged.entries };
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, report: result.report, provenance: result.provenance, output: outputOutcome, manifest: manifestOutcome, dryRun: args.dryRun }, null, 2));
    return;
  }

  console.log("Historical Dataset Intake — Phase 4 (offline, no provider/broker call)");
  console.log("========================================================================");
  console.log(`Instrument: ${result.report.instrument}   Timeframe: ${result.report.timeframe}   Source: ${result.report.source}`);
  console.log(`Input file: ${result.report.inputFile}   Rows: ${result.report.rowCount}   Invalid rows: ${result.report.invalidRowCount}`);
  console.log(`Range: ${result.report.firstTimestamp} .. ${result.report.lastTimestamp}   Duration(ms): ${result.report.durationMs}`);
  console.log(`Duplicates: ${result.report.duplicateCount}   Out-of-order: ${result.report.outOfOrderCount}   Gaps: ${result.report.gapCount}`);
  console.log(`Timezone handling: ${result.report.timezoneHandling}`);
  console.log(`Dataset hash: ${result.report.datasetHash}`);
  console.log(`Validation status: ${result.report.validationStatus}`);
  if (result.report.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of result.report.warnings) console.log(`  - ${w}`);
  }
  console.log("Limitations:");
  for (const l of result.report.limitations) console.log(`  - ${l}`);
  if (args.dryRun) console.log("\n--dry-run: no file was written.");
  if (outputOutcome) console.log(`\nOutput written: ${outputOutcome.filePath}`);
  if (manifestOutcome) console.log(`\nManifest ${manifestOutcome.outcome}: ${manifestOutcome.filePath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, stage: "execution", reason: "UNEXPECTED_ERROR", detail }, null, 2));
    } else {
      console.error("Dataset prepare crashed unexpectedly:", detail);
    }
    process.exitCode = 2;
  });
}
