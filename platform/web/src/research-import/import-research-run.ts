import * as path from "node:path";
import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import { getServerConfig } from "@/lib/config/server-config";
import { importResearchRun, ResearchRunImportError } from "@/lib/research-import";

// Phase 2 — Research Import. Standalone CLI entrypoint mirroring
// src/market-universe/refresh-universe.ts exactly: only ever run directly
// (`npm run import-research-run -- <run-id>`), never imported by the Next.js app or the worker.
// Deliberately not an API and not a directory watcher — importing one completed Hermes Lab run is
// a single, explicit, one-shot action an operator takes.
async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: npm run import-research-run -- <run-id>");
    process.exitCode = 1;
    return;
  }

  const client = getServiceRoleClient();
  if (!client) {
    console.error(
      "SUPABASE_SERVICE_ROLE_KEY and/or NEXT_PUBLIC_SUPABASE_URL are not set — the import has nothing to connect to.",
    );
    process.exitCode = 1;
    return;
  }

  const runDirectory = path.join(getServerConfig().researchRunsDirectory, runId);

  try {
    const result = await importResearchRun(client, runDirectory);
    console.log(`Research run imported: ${result.runId} (from ${runDirectory})`);
  } catch (error) {
    if (error instanceof ResearchRunImportError) {
      console.error(`Research run import rejected [${error.reason}]: ${error.message}`);
    } else {
      console.error("Research run import failed:", error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  }
}

main();
