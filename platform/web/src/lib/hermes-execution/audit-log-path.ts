import * as path from "node:path";

// Hermes Integration API v1. Single source of truth for the trading runtime's persisted audit log
// path — shared by market-runtime.ts (the writer, one process) and the read-only Hermes
// Integration API (a reader, the separate Next.js process on the same VPS). Both processes must
// share the same working directory (platform/web/) for this to resolve to the same file — see
// docs/hermes-integration-api.md's "Architecture" section for why that's the deployment
// assumption, and why this file is a read-only consumer, never a second writer.
export const HERMES_RUNTIME_AUDIT_LOG_PATH = path.join(
  process.cwd(),
  ".data",
  "hermes-execution",
  "market-runtime-audit-log.json",
);
