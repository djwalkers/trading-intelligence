import "server-only";
import * as fs from "node:fs/promises";
import { HERMES_RUNTIME_AUDIT_LOG_PATH } from "@/lib/hermes-execution/audit-log-path";
import type { AuditEvent } from "@/lib/hermes-execution/types";
import { logger } from "@/lib/logger/logger";

// Hermes Integration API v1. A pure, read-only consumer of the trading runtime's existing,
// already-persisted audit trail (JsonFileAuditTrail, written by the separate `market:runtime`
// process) — never writes to it, never constructs a JsonFileAuditTrail instance (whose own
// persist() would rewrite the whole file). This is the ONLY durable, cross-process record this
// Next.js server has of the runtime's history; there is no live in-process channel to the
// standalone runtime (see docs/hermes-integration-api.md's "Architecture" section — the same
// "automation: unknown" limitation get-application-health.ts already documents for the unrelated
// VPS worker applies here for the same structural reason: two separate OS processes).

export interface AuditLogReadResult {
  events: AuditEvent[];
  /**
   * `false` only when the file could not be read/parsed at all (a genuine I/O or corruption
   * problem) — distinct from "read successfully but empty" (a runtime that has never started, or
   * was very recently restarted — `JsonFileAuditTrail.createFresh()` truncates this file on every
   * process start, so an empty-but-readable file is an expected, normal state, not an outage).
   * Callers must report "unknown", never "zero"/"stopped", when this is false.
   */
  available: boolean;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function readHermesRuntimeAuditLog(
  filePath: string = HERMES_RUNTIME_AUDIT_LOG_PATH,
): Promise<AuditLogReadResult> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    // ENOENT (the runtime has never started, or its .data/ directory doesn't exist yet) is
    // expected and unremarkable — a normal "no history yet" state. Anything else (a permission or
    // I/O problem) is worth a log line, but this function still never throws.
    const isMissing = isErrnoException(error) && error.code === "ENOENT";
    if (!isMissing) {
      logger.warn("Hermes Integration API could not read the trading runtime audit log", {
        component: "hermes-integration-audit-log",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return { events: [], available: isMissing };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("Audit log root is not an array.");
    }
    return { events: parsed as AuditEvent[], available: true };
  } catch (error) {
    logger.warn("Hermes Integration API found a corrupted trading runtime audit log", {
      component: "hermes-integration-audit-log",
      reason: error instanceof Error ? error.message : String(error),
    });
    return { events: [], available: false };
  }
}
