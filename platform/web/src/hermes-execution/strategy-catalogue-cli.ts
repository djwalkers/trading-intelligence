import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { loadCapabilityEvidence, buildInstrumentCatalogue } from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";
import { loadStage4CapabilityEvidence } from "@/lib/hermes-execution/instrument-catalogue/stage4-capability-evidence";
import {
  loadStrategyDefinitions,
  selectLatestVersions,
  versionHistory,
  type RejectedStrategyFile,
} from "@/lib/hermes-execution/strategy-definitions/strategy-definition-registry";
import type { ValidatedStrategyRecord } from "@/lib/hermes-execution/strategy-definitions/strategy-definition";

// Phase 1 — Declarative Strategy Foundation CLI. Standalone, read-only: never connects to a broker,
// never calls eToro, never places/closes an order, never touches PM2, never imports or invokes the
// Stage-4 smoke tool, and never wires a strategy into live execution. Only ever reads local
// declarative strategy JSON files (see the repo's own `strategies/` directory) plus the existing,
// already-built Phase 0 instrument catalogue (read-only evidence only — this CLI never mutates
// catalogue or runtime state).

const STRATEGIES_DIR = process.env.HERMES_STRATEGY_DEFINITIONS_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), "strategies");
const EVIDENCE_DIR = process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), ".data", "hermes-execution", "etoro-capability-evidence");
const STAGE4_EVIDENCE_DIR =
  process.env.HERMES_INSTRUMENT_CATALOGUE_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), ".data", "hermes-execution", "etoro-stage4-capability-evidence");

// Phase 0 seed — identical list to instrument-catalogue-cli.ts's own PHASE_0_SEED_SYMBOLS. Kept as
// its own local constant (never imported from that CLI script) — a top-level CLI script never
// depends on another one, matching this codebase's existing convention.
const PHASE_0_SEED_SYMBOLS = ["BTC", "ETH", "SOL"];

const MAX_PRINTED_REJECTIONS = 10;

function printRejections(label: string, rejected: ReadonlyArray<{ filePath: string; reason: string; detail: string }>): void {
  console.log(`${label}: ${rejected.length}`);
  for (const r of rejected.slice(0, MAX_PRINTED_REJECTIONS)) {
    console.log(`  - ${r.filePath}: ${r.reason} — ${r.detail}`);
  }
  const omitted = rejected.length - MAX_PRINTED_REJECTIONS;
  if (omitted > 0) {
    console.log(`  ...and ${omitted} more rejection(s) omitted (see --json for the full list).`);
  }
}

// Short prefix only — a full 64-hex-char SHA-256 digest would make every default human-output row
// excessively wide; the full value is always available via --json (result.provenance.contentHash).
const HUMAN_HASH_PREFIX_LENGTH = 8;

function formatRow(record: ValidatedStrategyRecord, versionCount: number): string {
  const { document, result } = record;
  const { contentHashAlgorithm, contentHash } = result.provenance;
  return (
    `${document.strategyId.padEnd(24)}  ` +
    `v${document.strategyVersion.padEnd(9)}  ` +
    `status=${document.status.padEnd(22)}  ` +
    `usableForBacktest=${(result.usableForBacktest ? "yes" : "no").padEnd(3)}  ` +
    `usableForDemo=${(result.usableForDemo ? "yes" : "no").padEnd(3)}  ` +
    `instruments=${result.supportedCatalogueInstruments.join(",") || "none"}  ` +
    `versions=${versionCount}  ` +
    `hash=${contentHashAlgorithm}:${contentHash.slice(0, HUMAN_HASH_PREFIX_LENGTH)}…`
  );
}

export async function main(): Promise<void> {
  const asJson = process.argv.slice(2).some((arg) => arg.trim().toLowerCase() === "--json");
  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);

  const config = getHermesExecutionConfig();
  const evidence = await loadCapabilityEvidence(EVIDENCE_DIR, { nowMs });
  const stage4Evidence = await loadStage4CapabilityEvidence(STAGE4_EVIDENCE_DIR, { nowMs });
  const catalogueEntries = buildInstrumentCatalogue({
    seedSymbols: PHASE_0_SEED_SYMBOLS,
    configuredUniverse: config.hermesAgent.instrumentUniverse,
    evidence,
    stage4Evidence,
  });

  // Same instant as `generatedAt` — one clock read for the whole CLI invocation, so every
  // strategy's own `loadedAt` matches the catalogue's own generation timestamp exactly.
  const strategyLoad = await loadStrategyDefinitions(STRATEGIES_DIR, catalogueEntries, { now: () => generatedAt });
  const latest = selectLatestVersions(strategyLoad.accepted);
  const latestRecords = [...latest.values()].sort((a, b) => a.document.strategyId.localeCompare(b.document.strategyId));

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt,
          sourceDirectory: STRATEGIES_DIR,
          providerCallsMade: 0,
          rejectedCount: strategyLoad.rejected.length,
          rejected: strategyLoad.rejected,
          strategies: latestRecords.map((record) => ({
            document: record.document,
            result: record.result,
            history: versionHistory(strategyLoad.accepted, record.document.strategyId).map((r) => ({
              strategyVersion: r.document.strategyVersion,
              status: r.document.status,
              valid: r.result.valid,
              filePath: r.filePath,
              contentHash: r.result.provenance.contentHash,
              loadedAt: r.result.provenance.loadedAt,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("Declarative Strategy Catalogue — Phase 1 (read-only)");
  console.log("=====================================================");
  console.log("No provider calls made. Never wired into live execution. Reads only local strategy");
  console.log("definition files and the existing, already-built instrument catalogue.");
  console.log(`Catalogue generated at: ${generatedAt}`);
  console.log(`Strategy definitions source directory: ${STRATEGIES_DIR}`);
  console.log("");
  if (latestRecords.length === 0) {
    console.log("(no valid strategy definitions found)");
  }
  for (const record of latestRecords) {
    const count = versionHistory(strategyLoad.accepted, record.document.strategyId).length;
    console.log(formatRow(record, count));
  }
  console.log("");
  printRejections("Rejected strategy files", strategyLoad.rejected as RejectedStrategyFile[]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Strategy catalogue generation crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
