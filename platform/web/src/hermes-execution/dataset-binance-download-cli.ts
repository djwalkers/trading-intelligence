import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildArchiveLocation,
  checkNoMonthOverlap,
  computeSha256Hex,
  generateMonthRange,
  INSTRUMENT_TO_BINANCE_SYMBOL,
  parseBinanceKlineCsv,
  parseChecksumFile,
  RESEARCH_INSTRUMENTS,
  SOURCE_LABEL_FOR_INSTRUMENT,
  validateMonthlyArchiveRows,
  type ArchiveLocation,
  type BinanceKlineRow,
  type BinanceSymbol,
  type ResearchInstrument,
  type ValidatedMonthlyArchive,
} from "@/lib/hermes-execution/dataset-intake/binance-archive";
import {
  BINANCE_KNOWN_MARKET_CLOSURES,
  BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION,
  closureRecordIdentity,
  findClosureRecord,
  resolveKnownMissingOpenTimesForSymbolMonth,
} from "@/lib/hermes-execution/dataset-intake/binance-known-market-closures";
import { extractSingleFileFromZip } from "@/lib/hermes-execution/dataset-intake/binance-zip";
import { DEFAULT_DOWNLOAD_OPTIONS, downloadAndVerifyArchive, type DownloadOptions } from "@/lib/hermes-execution/dataset-intake/binance-downloader";
import { DATASET_INTAKE_CONVERTER_VERSION, prepareDataset, type PrepareDatasetResult } from "@/lib/hermes-execution/dataset-intake/dataset-intake";
import { appendManifestEntry } from "@/lib/hermes-execution/dataset-intake/manifest-writer";
import type { DatasetKnownClosure } from "@/lib/hermes-execution/backtest/backtest-dataset";
import type { DatasetManifestEntry, DatasetRole } from "@/lib/hermes-execution/strategy-research/dataset-manifest";

// Phase 4 — Historical Dataset Intake. Operator-run acquisition of Binance's OFFICIAL public spot
// monthly kline archives for BTCUSDT/ETHUSDT/SOLUSDT, assembled into Phase 2 `CandleDatasetDocument`
// files for CRYPTO_EMA_TREND_V1's own IN_SAMPLE (2023-2024) / OUT_OF_SAMPLE (2025) research periods.
// Two internal stages, kept as genuinely separate concerns (never merged into one function): (1)
// download+checksum-verify+cache each monthly ZIP (binance-downloader.ts — the ONLY network I/O in
// this entire pipeline), and (2) assemble the verified, extracted rows and hand them to Phase 4's OWN
// `prepareDataset` (never a second, parallel dataset validator) for the real Phase 2 schema/hash. No
// broker/provider/runtime import; never runs the research plan; never touches the strategy registry.
//
// Exit codes: 0 = requested downloads (and, once all 36 required months are cached, the full
// assemble+prepare+manifest step) completed. 1 = an explicit, expected rejection — bad arguments, a
// download/checksum/archive-shape failure, or a Phase 2 validation rejection. 2 = an unexpected crash.

const REQUIRED_MONTHS_FROM = "2023-01";
const REQUIRED_MONTHS_TO = "2025-12";
/** Fixed business rule for THIS research dataset's own target periods — never derived from "now,"
 * and never raised by any CLI flag: this tool must never acquire or assemble 2026 data. */
const MAX_ALLOWED_MONTH = "2025-12";

const IN_SAMPLE_ROLE: { role: DatasetRole; from: string; to: string; monthsFrom: string; monthsTo: string } = {
  role: "IN_SAMPLE",
  from: "2023-01-01T00:00:00.000Z",
  to: "2025-01-01T00:00:00.000Z",
  monthsFrom: "2023-01",
  monthsTo: "2024-12",
};
const OUT_OF_SAMPLE_ROLE: { role: DatasetRole; from: string; to: string; monthsFrom: string; monthsTo: string } = {
  role: "OUT_OF_SAMPLE",
  from: "2025-01-01T00:00:00.000Z",
  to: "2026-01-01T00:00:00.000Z",
  monthsFrom: "2025-01",
  monthsTo: "2025-12",
};
const ROLES = [IN_SAMPLE_ROLE, OUT_OF_SAMPLE_ROLE] as const;

export const BINANCE_ACQUISITION_TOOL_VERSION = 1;

interface ParsedArgs {
  from: string;
  to: string;
  outputRoot: string;
  json: boolean;
  dryRun: boolean;
}

const FLAGS_WITH_VALUES = ["--from", "--to", "--output-root"] as const;
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
  const missing = ["--from", "--to", "--output-root"].filter((f) => !raw.has(f));
  if (missing.length > 0) return { ok: false, json, detail: `missing required argument(s): ${missing.join(", ")}` };
  return { ok: true, args: { from: raw.get("--from")!, to: raw.get("--to")!, outputRoot: raw.get("--output-root")!, json, dryRun } };
}

/**
 * Pre-commit review fix. `--output-root` previously accepted ANY string with zero validation — an
 * operator typo (an empty value, `/`, or this project's own `src/` tree) could scatter this tool's
 * downloaded archives, prepared datasets, and manifests across the filesystem root or directly into
 * source control. Rejected outright before any directory is ever created or written to.
 */
function rejectUnsafeOutputRoot(outputRoot: string): string | undefined {
  const trimmed = outputRoot.trim();
  if (trimmed.length === 0) return "--output-root must not be empty or whitespace-only";
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    return `--output-root must not be a filesystem root (resolved to "${resolved}")`;
  }
  const repoRoot = path.resolve(process.cwd());
  const srcRoot = path.resolve(repoRoot, "src");
  if (resolved === repoRoot || resolved === srcRoot || resolved.startsWith(`${srcRoot}${path.sep}`)) {
    return `--output-root must not be this project's own repository root or source directory (resolved to "${resolved}") — pass a dedicated data directory instead`;
  }
  return undefined;
}

function printUsage(): void {
  console.error("Usage: npm run dataset:binance-download -- --from <YYYY-MM> --to <YYYY-MM> --output-root <dir> [--json] [--dry-run]");
}

function fail(json: boolean, stage: string, reason: string, detail: string, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, stage, reason, detail, ...extra }, null, 2));
  } else {
    console.error(`[${stage}] ${reason}: ${detail}`);
  }
  process.exitCode = 1;
}

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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, reason: "OUTPUT_ALREADY_EXISTS", detail: `${filePath} already exists — never overwritten` };
      throw error;
    }
  } catch (error) {
    return { ok: false, reason: "WRITE_ERROR", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

interface RequestedDownloadPlan {
  locations: ArchiveLocation[];
}

function buildRequestedPlan(from: string, to: string): { ok: true; plan: RequestedDownloadPlan } | { ok: false; detail: string } {
  const monthRange = generateMonthRange(from, to);
  if (!monthRange.ok) return { ok: false, detail: monthRange.detail };
  if (monthRange.months.some((m) => m > MAX_ALLOWED_MONTH)) {
    return { ok: false, detail: `this tool's own research target never includes data after ${MAX_ALLOWED_MONTH} — requested range includes a later month` };
  }
  const locations: ArchiveLocation[] = [];
  for (const instrument of RESEARCH_INSTRUMENTS) {
    for (const month of monthRange.months) locations.push(buildArchiveLocation(INSTRUMENT_TO_BINANCE_SYMBOL[instrument], month));
  }
  return { ok: true, plan: { locations } };
}

interface ArchiveCacheCheck {
  instrument: ResearchInstrument;
  month: string;
  zipFileName: string;
  status: "verified" | "missing" | "corrupt";
  /** Only ever set on a "verified" result — the archive's own recomputed sha256. */
  sha256?: string;
  detail?: string;
}

/** Reads back whatever is ALREADY on disk (from this run's own downloads, or any PRIOR run) and
 * re-verifies each required archive's sha256 against its own locally-cached `.CHECKSUM` file — never
 * trusting a cached file merely because it exists. No network call: this is purely a local-cache
 * audit, which is what makes incremental, multi-run acquisition ("resumable downloads") safe. */
async function auditLocalCache(sourceDir: string, instrument: ResearchInstrument): Promise<ArchiveCacheCheck[]> {
  const monthRange = generateMonthRange(REQUIRED_MONTHS_FROM, REQUIRED_MONTHS_TO);
  if (!monthRange.ok) throw new Error(monthRange.detail);
  const results: ArchiveCacheCheck[] = [];
  for (const month of monthRange.months) {
    const location = buildArchiveLocation(INSTRUMENT_TO_BINANCE_SYMBOL[instrument], month);
    const zipPath = path.join(sourceDir, location.zipFileName);
    const checksumPath = path.join(sourceDir, location.checksumFileName);
    try {
      const [zipBytes, checksumText] = await Promise.all([fs.readFile(zipPath), fs.readFile(checksumPath, "utf-8")]);
      const parsed = parseChecksumFile(checksumText, location.zipFileName);
      if (!parsed.ok) {
        results.push({ instrument, month, zipFileName: location.zipFileName, status: "corrupt", detail: parsed.detail });
        continue;
      }
      const actual = computeSha256Hex(zipBytes);
      if (actual !== parsed.sha256) {
        results.push({ instrument, month, zipFileName: location.zipFileName, status: "corrupt", detail: `cached archive sha256 ${actual} does not match its own cached checksum ${parsed.sha256}` });
        continue;
      }
      results.push({ instrument, month, zipFileName: location.zipFileName, status: "verified", sha256: actual });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        results.push({ instrument, month, zipFileName: location.zipFileName, status: "missing" });
      } else {
        results.push({ instrument, month, zipFileName: location.zipFileName, status: "corrupt", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return results;
}

async function extractAndValidateArchive(sourceDir: string, instrument: ResearchInstrument, month: string): Promise<{ ok: true; archive: ValidatedMonthlyArchive } | { ok: false; reason: string; detail: string }> {
  const symbol = INSTRUMENT_TO_BINANCE_SYMBOL[instrument];
  const location = buildArchiveLocation(symbol, month);
  const zipBytes = await fs.readFile(path.join(sourceDir, location.zipFileName));
  const extracted = extractSingleFileFromZip(zipBytes, location.csvFileName);
  if (!extracted.ok) return extracted;
  const parsed = parseBinanceKlineCsv(extracted.content.toString("utf-8"));
  if (!parsed.ok) return parsed;
  // Only a gap EXACTLY covered by the committed binance-known-market-closures.ts registry (for this
  // exact symbol/month) is ever accepted — never guessed from the gap itself, never a CLI override.
  const knownMissingOpenTimes = resolveKnownMissingOpenTimesForSymbolMonth(symbol, month);
  return validateMonthlyArchiveRows(parsed.rows as readonly BinanceKlineRow[], month, knownMissingOpenTimes);
}

/** Resolves EVERY known-closure hour a symbol's archives across `archives` were permitted to skip
 * (see `ValidatedMonthlyArchive.appliedKnownMissingOpenTimes`) into fully-evidenced
 * `DatasetKnownClosure` records — one per missing hour, `symbol` stamped as the RESEARCH instrument
 * (matching the prepared document's own `instrument`, never the raw Binance pair) so Phase 2's own
 * `validateCandleDataset` can cross-check it directly against the document it's attached to. Returns
 * `undefined` when no closure applied anywhere in `archives` — callers never attach an empty array. */
function resolveDocumentKnownClosures(instrument: ResearchInstrument, archives: readonly ValidatedMonthlyArchive[]): DatasetKnownClosure[] | undefined {
  const binanceSymbol: BinanceSymbol = INSTRUMENT_TO_BINANCE_SYMBOL[instrument];
  const closures: DatasetKnownClosure[] = [];
  for (const archive of archives) {
    for (const missingOpenTime of archive.appliedKnownMissingOpenTimes) {
      const registryEntry = findClosureRecord(binanceSymbol, missingOpenTime);
      if (registryEntry === undefined) {
        // Cannot happen: `appliedKnownMissingOpenTimes` is only ever populated from
        // `resolveKnownMissingOpenTimesForSymbolMonth`, itself derived from this same registry.
        throw new Error(`internal error: ${instrument} ${missingOpenTime} was accepted as a known closure but no longer resolves against the registry`);
      }
      closures.push({
        provider: registryEntry.provider,
        market: registryEntry.market,
        symbol: instrument,
        timeframe: "1h",
        missingOpenTime,
        reasonCode: registryEntry.reasonCode,
        description: registryEntry.description,
        sourceReference: registryEntry.sourceReference,
        status: registryEntry.status,
        registryVersion: BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION,
        closureId: closureRecordIdentity(registryEntry, binanceSymbol),
      });
    }
  }
  return closures.length > 0 ? closures : undefined;
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    fail(parsed.json, "args", "INVALID_ARGUMENTS", parsed.detail);
    printUsage();
    return;
  }
  const args = parsed.args;
  const unsafeRoot = rejectUnsafeOutputRoot(args.outputRoot);
  if (unsafeRoot !== undefined) {
    fail(args.json, "args", "UNSAFE_OUTPUT_ROOT", unsafeRoot);
    return;
  }
  const options: DownloadOptions = DEFAULT_DOWNLOAD_OPTIONS;
  const sourceDir = path.join(args.outputRoot, "source", "binance");
  const preparedDir = path.join(args.outputRoot, "prepared");
  const manifestsDir = path.join(args.outputRoot, "manifests");
  const now = () => new Date().toISOString();

  const planResult = buildRequestedPlan(args.from, args.to);
  if (!planResult.ok) {
    fail(args.json, "args", "INVALID_RANGE", planResult.detail);
    return;
  }

  if (args.dryRun) {
    const report = { ok: true, dryRun: true, locations: planResult.plan.locations };
    console.log(args.json ? JSON.stringify(report, null, 2) : planResult.plan.locations.map((l) => `${l.zipUrl}\n${l.checksumUrl}`).join("\n"));
    return;
  }

  const downloadResults: { instrument: ResearchInstrument; month: string; zipFileName: string; sha256?: string; status: string; detail?: string }[] = [];
  for (const location of planResult.plan.locations) {
    const instrument = RESEARCH_INSTRUMENTS.find((i) => INSTRUMENT_TO_BINANCE_SYMBOL[i] === location.symbol)!;
    const downloaded = await downloadAndVerifyArchive(location, sourceDir, options);
    if (!downloaded.ok) {
      fail(args.json, "download", downloaded.reason, `${location.zipFileName}: ${downloaded.detail}`, { downloadResults });
      return;
    }
    downloadResults.push({ instrument, month: location.month, zipFileName: location.zipFileName, sha256: downloaded.result.sha256, status: downloaded.result.status });
  }

  // Stage 2: assemble, ALWAYS attempted against the FIXED full required range (2023-01..2025-12),
  // read entirely from the local cache — never gated on THIS invocation's own --from/--to, so
  // multiple incremental download runs correctly converge to a full assembly once every required
  // archive is present, whichever run fetched it.
  const cacheAudits = await Promise.all(RESEARCH_INSTRUMENTS.map((i) => auditLocalCache(sourceDir, i)));
  const allAudits = cacheAudits.flat();
  const incomplete = allAudits.filter((c) => c.status !== "verified");
  if (incomplete.length > 0) {
    const summary = { ok: true, stage1: { downloadResults }, stage2: { skipped: true, reason: "INCOMPLETE_LOCAL_CACHE", missingOrCorrupt: incomplete } };
    console.log(args.json ? JSON.stringify(summary, null, 2) : `Stage 1 complete. Stage 2 skipped — ${incomplete.length} required archive(s) not yet verified locally. Re-run with additional --from/--to coverage.`);
    return;
  }
  // Every one of the 108 required archives is now "verified" — `allAudits` therefore carries the
  // FULL evidentiary set (each with its own recomputed sha256), regardless of which invocation(s)
  // actually downloaded them. `downloadResults` above only ever reflects THIS invocation's own
  // downloads and would silently under-report source archives/checksums in the (explicitly
  // supported, see this module's own doc comment) incremental multi-run acquisition workflow — never
  // used for the acquisition report below for that reason.
  const verifiedSourceArchives = allAudits.map((c) => ({ instrument: c.instrument, month: c.month, zipFileName: c.zipFileName, sha256: c.sha256!, status: "verified" as const }));

  const perInstrumentArchives = new Map<ResearchInstrument, ValidatedMonthlyArchive[]>();
  for (const instrument of RESEARCH_INSTRUMENTS) {
    const monthRange = generateMonthRange(REQUIRED_MONTHS_FROM, REQUIRED_MONTHS_TO);
    if (!monthRange.ok) throw new Error(monthRange.detail);
    const archives: ValidatedMonthlyArchive[] = [];
    for (const month of monthRange.months) {
      const result = await extractAndValidateArchive(sourceDir, instrument, month);
      if (!result.ok) {
        fail(args.json, "archive", result.reason, `${instrument} ${month}: ${result.detail}`);
        return;
      }
      archives.push(result.archive);
    }
    const overlapCheck = checkNoMonthOverlap(archives);
    if (!overlapCheck.ok) {
      fail(args.json, "archive", "MONTH_OVERLAP", `${instrument}: ${overlapCheck.detail}`);
      return;
    }
    perInstrumentArchives.set(instrument, archives);
  }

  const manifestPath = path.join(manifestsDir, "research-plan-manifest.json");
  const preparedResults: { instrument: ResearchInstrument; role: DatasetRole; filePath: string; result: PrepareDatasetResult }[] = [];
  for (const instrument of RESEARCH_INSTRUMENTS) {
    const archives = perInstrumentArchives.get(instrument)!;
    for (const roleConfig of ROLES) {
      const roleArchives = archives.filter((a) => a.month >= roleConfig.monthsFrom && a.month <= roleConfig.monthsTo);
      const rows = roleArchives.flatMap((a) => a.candles);
      const rawText = JSON.stringify(rows);
      const knownClosures = resolveDocumentKnownClosures(instrument, roleArchives);
      const result = prepareDataset({
        rawText,
        format: "json",
        instrument,
        timeframe: "1h",
        source: SOURCE_LABEL_FOR_INSTRUMENT[instrument],
        timezone: "UTC",
        inputFileLabel: `${instrument}_${roleConfig.role}_1h.json`,
        dateFrom: roleConfig.from,
        dateTo: roleConfig.to,
        importedAt: now(),
        ...(knownClosures !== undefined ? { knownClosures } : {}),
      });
      if (!result.ok) {
        fail(args.json, "validation", result.reason, `${instrument} ${roleConfig.role}: ${result.detail}`, { report: result.report });
        return;
      }
      const outputPath = path.join(preparedDir, `${instrument}_${roleConfig.role}_1h.json`);
      preparedResults.push({ instrument, role: roleConfig.role, filePath: outputPath, result });
    }
  }

  for (const { filePath, result } of preparedResults) {
    if (!result.ok) continue;
    const written = await writeCreateOnly(filePath, JSON.stringify(result.document, null, 2));
    if (!written.ok) {
      fail(args.json, "output", written.reason, written.detail);
      return;
    }
  }

  const manifestEntries: DatasetManifestEntry[] = [];
  for (const { instrument, role, filePath, result } of preparedResults) {
    if (!result.ok) continue;
    const entry: DatasetManifestEntry = {
      instrument,
      timeframe: "1h",
      datasetFile: path.relative(manifestsDir, filePath),
      expectedDatasetHash: result.datasetHash,
      startTimestamp: result.document.candles[0]!.timestamp,
      endTimestamp: result.document.candles[result.document.candles.length - 1]!.timestamp,
      role,
    };
    manifestEntries.push(entry);
    const merged = await appendManifestEntry(manifestPath, entry, false);
    if (!merged.ok) {
      fail(args.json, "manifest", merged.reason, merged.detail);
      return;
    }
  }

  const acquisitionReport = {
    provider: "Binance public archive",
    market: "spot",
    quoteAsset: "USDT",
    symbols: RESEARCH_INSTRUMENTS.map((i) => INSTRUMENT_TO_BINANCE_SYMBOL[i]),
    archiveMonths: generateMonthRange(REQUIRED_MONTHS_FROM, REQUIRED_MONTHS_TO).ok ? generateMonthRange(REQUIRED_MONTHS_FROM, REQUIRED_MONTHS_TO) : undefined,
    sourceArchives: verifiedSourceArchives,
    detectedTimestampUnits: [...perInstrumentArchives.entries()].flatMap(([instrument, archives]) => archives.map((a) => ({ instrument, month: a.month, unit: a.unit }))),
    datasets: preparedResults.map(({ instrument, role, result }) => ({
      instrument,
      role,
      rowCount: result.ok ? result.document.candles.length : null,
      firstTimestamp: result.ok ? result.document.candles[0]!.timestamp : null,
      lastTimestamp: result.ok ? result.document.candles[result.document.candles.length - 1]!.timestamp : null,
      datasetHash: result.ok ? result.datasetHash : null,
      inputFileHash: result.ok ? result.provenance.inputFileHash : null,
      appliedKnownClosureCount: result.ok ? result.provenance.appliedKnownClosures.length : null,
    })),
    // Every known-market-closure entry actually EXERCISED (never merely declared) to explain a real
    // gap in any prepared dataset — sourced from binance-known-market-closures.ts via each dataset's
    // own Phase 2 `provenance.appliedKnownClosures`, never re-derived or guessed here. Empty when no
    // closure ever applied. `candleSynthesized` is always `false`: explaining a gap never inserts,
    // interpolates, or forward-fills a candle for the missing hour, here or anywhere else in this
    // pipeline.
    knownMarketClosures: {
      registryVersion: BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION,
      // Every entry the committed registry declares — regardless of whether this particular run ever
      // needed it — so a reviewer can see what was AVAILABLE to explain a gap, distinct from `applied`
      // below (what was actually exercised). Verbatim from binance-known-market-closures.ts; never
      // fetched, never re-derived, never symbol-resolved (unlike `applied`, which is per-instrument).
      registryEntries: BINANCE_KNOWN_MARKET_CLOSURES.map((entry) => ({
        provider: entry.provider,
        market: entry.market,
        appliesToSymbols: entry.appliesToSymbols,
        timeframe: entry.timeframe,
        missingOpenTime: entry.missingOpenTime,
        reasonCode: entry.reasonCode,
        status: entry.status,
      })),
      applied: preparedResults.flatMap(({ instrument, role, result }) =>
        result.ok
          ? result.provenance.appliedKnownClosures.map((closure) => ({
              instrument,
              role,
              symbol: INSTRUMENT_TO_BINANCE_SYMBOL[instrument],
              missingOpenTime: closure.missingOpenTime,
              reasonCode: closure.reasonCode,
              description: closure.description,
              sourceReference: closure.sourceReference,
              registryVersion: closure.registryVersion,
              closureId: closure.closureId,
              candleSynthesized: false,
            }))
          : [],
      ),
    },
    converterVersion: DATASET_INTAKE_CONVERTER_VERSION,
    binanceAcquisitionToolVersion: BINANCE_ACQUISITION_TOOL_VERSION,
    generatedAt: now(),
    warnings: [] as string[],
    limitations: [
      "This represents Binance SPOT market data only — never futures, never an exchange-independent reference price.",
      "All three instruments are quoted against USDT — results are USDT-pair-specific and do not necessarily generalise to other quote assets or venues.",
      "Successful validation of these datasets establishes only that they are mechanically well-formed and complete for their declared period — it never establishes, implies, or predicts future profitability of any strategy run against them.",
      "No automatic promotion: this tool never modifies the committed example research plan, never runs a research plan, and never wires this data into any approval, execution, lifecycle, or live-trading path.",
      "Any candle gap accepted via knownMarketClosures represents a genuine, documented Binance venue outage, never a data-quality shortcut — no candle is ever synthesized, interpolated, or forward-filled for the missing hour, and no strategy could have traded Binance spot during it.",
    ],
  };
  const reportWrite = await writeCreateOnly(path.join(manifestsDir, "acquisition-report.json"), JSON.stringify(acquisitionReport, null, 2));
  if (!reportWrite.ok && reportWrite.reason !== "OUTPUT_ALREADY_EXISTS") {
    fail(args.json, "report", reportWrite.reason, reportWrite.detail);
    return;
  }

  const placeholderReplacement = {
    instructions: "Copy these entries into strategies/research-plans/CRYPTO_EMA_TREND_V1_BASELINE_NEIGHBOURHOOD__1.0.0.json's own `datasets` array, replacing the PLACEHOLDER entries — this file is never edited automatically.",
    entries: manifestEntries,
  };
  await writeCreateOnly(path.join(manifestsDir, "plan-placeholder-replacement.json"), JSON.stringify(placeholderReplacement, null, 2));

  if (args.json) {
    console.log(JSON.stringify({ ok: true, stage1: { downloadResults }, stage2: { manifestPath, acquisitionReport }, outputs: preparedResults.map((r) => r.filePath) }, null, 2));
    return;
  }
  console.log("Binance historical dataset acquisition — Phase 4 (offline once cached; network only on explicit run)");
  console.log("=======================================================================================================");
  for (const { instrument, role, filePath, result } of preparedResults) {
    console.log(`${instrument} ${role}: ${filePath}${result.ok ? ` (hash ${result.datasetHash.slice(0, 12)}…, ${result.document.candles.length} candles)` : ""}`);
  }
  console.log(`\nManifest: ${manifestPath}`);
  console.log(`Acquisition report + plan-placeholder replacement written under: ${manifestsDir}`);
  console.log("\nThe committed example research plan was NOT modified — see plan-placeholder-replacement.json for exact values to copy in manually.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ ok: false, stage: "execution", reason: "UNEXPECTED_ERROR", detail }, null, 2));
    } else {
      console.error("Binance dataset download crashed unexpectedly:", detail);
    }
    process.exitCode = 2;
  });
}
