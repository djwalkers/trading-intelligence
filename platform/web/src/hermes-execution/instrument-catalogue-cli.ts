import * as path from "node:path";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import {
  loadCapabilityEvidence,
  buildInstrumentCatalogue,
  type InstrumentCatalogueEntry,
  type RejectedEvidenceFile,
} from "@/lib/hermes-execution/instrument-catalogue/instrument-catalogue";

// Phase 0 — Instrument Catalogue CLI. Standalone, read-only: never connects to a broker, never
// calls eToro, never places/closes an order, never touches PM2 or any live trading process. Only
// ever reads local evidence JSON files (already produced by a prior, separate
// `npm run broker:etoro-probe` run) plus the app's own config. See
// docs/project-status/INSTRUMENT_CATALOGUE_PHASE0.md for the full design.

// Overridable only for test isolation (never touched by the real CLI invocation, which always
// reads the actual evidence directory) — avoids racing against other suites' own real, shared
// .data/hermes-execution writes when this tool's own tests run in parallel with them.
const EVIDENCE_DIR = process.env.HERMES_INSTRUMENT_CATALOGUE_EVIDENCE_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), ".data", "hermes-execution", "etoro-capability-evidence");

// Phase 0 seed — deliberately NOT config.hermesAgent.instrumentUniverse (which may list equities
// with zero verified evidence). See instrument-catalogue.ts's own BuildCatalogueOptions doc comment.
const PHASE_0_SEED_SYMBOLS = ["BTC", "ETH", "SOL"];

function formatRow(entry: InstrumentCatalogueEntry): string {
  return (
    `${entry.symbol.padEnd(5)}` +
    `configured=${entry.configuredInUniverse ? "yes" : "no "}  ` +
    `readOnly=${entry.readOnlyCapabilityStatus.padEnd(18)}  ` +
    `stage4=${entry.stage4CapabilityStatus.padEnd(10)}  ` +
    `inTradingUniverse=${entry.inConfiguredTradingUniverse ? "yes" : "no"}`
  );
}

// Keeps default console output bounded even if the evidence directory accumulates many rejected
// files over time — --json still returns the full, uncapped list (the machine-readable contract).
const MAX_PRINTED_REJECTIONS = 10;

function printRejections(rejected: RejectedEvidenceFile[]): void {
  console.log(`Rejected evidence files: ${rejected.length}`);
  for (const r of rejected.slice(0, MAX_PRINTED_REJECTIONS)) {
    console.log(`  - ${r.filePath}: ${r.reason} — ${r.detail}`);
  }
  const omitted = rejected.length - MAX_PRINTED_REJECTIONS;
  if (omitted > 0) {
    console.log(`  ...and ${omitted} more rejection(s) omitted (see --json for the full list).`);
  }
}

export async function main(): Promise<void> {
  const asJson = process.argv.slice(2).some((arg) => arg.trim().toLowerCase() === "--json");
  const generatedAt = new Date().toISOString();

  const config = getHermesExecutionConfig();
  const evidence = await loadCapabilityEvidence(EVIDENCE_DIR, { nowMs: Date.parse(generatedAt) });
  const entries = buildInstrumentCatalogue({
    seedSymbols: PHASE_0_SEED_SYMBOLS,
    configuredUniverse: config.hermesAgent.instrumentUniverse,
    evidence,
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedAt,
          sourceDirectory: EVIDENCE_DIR,
          providerCallsMade: 0,
          rejectedEvidenceCount: evidence.rejected.length,
          rejected: evidence.rejected,
          entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("eToro Instrument Catalogue — Phase 0 (read-only)");
  console.log("=================================================");
  console.log("No provider calls made. Reads only local evidence files and existing configuration.");
  console.log(`Catalogue generated at: ${generatedAt}`);
  console.log(`Evidence source directory: ${EVIDENCE_DIR}`);
  console.log("");
  for (const entry of entries) {
    console.log(formatRow(entry));
  }
  console.log("");
  printRejections(evidence.rejected);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Instrument catalogue generation crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
