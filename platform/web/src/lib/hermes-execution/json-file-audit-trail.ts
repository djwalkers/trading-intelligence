import "server-only";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/lib/logger/logger";
import { InMemoryAuditTrail } from "./audit-trail";
import type { AuditEvent } from "./types";

export const DEFAULT_AUDIT_LOG_PATH = path.join(
  process.cwd(),
  ".data",
  "hermes-execution",
  "audit-log.json",
);

/** Thrown by loadExisting() when the file on disk exists but is not valid JSON, or not a JSON
 * array — distinct from "the file does not exist yet" (a legitimate, expected first-run state,
 * still silently treated as an empty log). A corrupted audit log is never silently discarded and
 * replaced with an empty history; that would erase evidence of exactly the kind of failure this
 * audit trail exists to surface. */
export class AuditTrailCorruptionError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Hermes execution audit log at "${filePath}" is corrupted: ${reason}`);
    this.name = "AuditTrailCorruptionError";
  }
}

/** Thrown when a write (or the read inside loadExisting(), for any failure other than the file
 * simply not existing yet) genuinely fails — disk full, permissions, a rename across filesystems,
 * etc. Write failures must be observable by callers, never only logged and silently swallowed (the
 * prior behaviour) — see record()/persist()'s own doc comments for exactly what each caller is
 * expected to do about it. */
export class AuditTrailPersistenceError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Failed to durably persist the Hermes execution audit log to "${filePath}": ${reason}`);
    this.name = "AuditTrailPersistenceError";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Same local-JSON-file pattern as JsonFilePaperBrokerStore. Each demo run starts a fresh log (see
 * `createFresh`) so the persisted file always reflects the most recent full replay, not an
 * ever-growing history — the system-health panel reads this file to answer "what happened last".
 *
 * Restart-Resilient Autonomy Phase — audit-durability hardening (a safety review found the
 * original implementation silently swallowed every write failure, wrote non-atomically — a crash
 * mid-`writeFile` could leave a truncated/corrupt destination file — and silently discarded a
 * malformed existing file as if it were empty). Every write now:
 *  - Writes to a per-attempt-unique temp file, fsyncs it, then atomically renames it over the
 *    destination — a crash at any point before the rename leaves the PRIOR, still-valid file
 *    untouched; a crash after the rename leaves the NEW, complete file in place. There is no
 *    window where the destination is a partially-written/truncated file.
 *  - Serializes writes from THIS process instance: concurrent record() calls queue behind a
 *    private write-lock, so two overlapping persist() calls from the SAME process never race each
 *    other's temp file or rename. A second, independent OS PROCESS writing the same path
 *    concurrently is not (and cannot be, with plain fs primitives, without a cross-process lock
 *    file this class deliberately does not add — out of scope for a single PM2-supervised process)
 *    serialized the same way, but the unique-per-attempt temp filename means it can never corrupt
 *    or interleave with this process's own write either — the only possible outcome is "last
 *    rename wins," never a garbled file.
 *  - Raises AuditTrailPersistenceError on any write failure, and AuditTrailCorruptionError from
 *    loadExisting() when the existing file is present but not valid JSON — both observable to
 *    callers (record() now REJECTS instead of resolving-after-silently-swallowing), rather than
 *    only logged. trading-runtime.ts's own recordAudit() wrapper catches-and-logs this for
 *    routine, non-safety-critical events (preserving its own "never rejects" cycle contract);
 *    autoApproveTradeCandidate specifically does NOT swallow it for its own
 *    TRADE_CANDIDATE_AUTO_APPROVED write (see that function's own doc comment).
 */
export class JsonFileAuditTrail extends InMemoryAuditTrail {
  /** Chains writes so overlapping record() calls from this process never race each other's temp
   * file/rename — each write waits for the previous one to fully settle before starting its own. */
  private writeLock: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    initialEvents: AuditEvent[],
  ) {
    super();
    this.events = initialEvents;
  }

  static async createFresh(filePath: string = DEFAULT_AUDIT_LOG_PATH): Promise<JsonFileAuditTrail> {
    const trail = new JsonFileAuditTrail(filePath, []);
    await trail.persist();
    return trail;
  }

  /** Restores prior history from `filePath` if it exists. A missing file (first-ever run) is a
   * legitimate, expected empty-log state. A file that EXISTS but fails to parse as a JSON array is
   * NOT — that is real corruption, and is raised as AuditTrailCorruptionError rather than silently
   * treated as "no history," which would otherwise mask the exact class of failure this durability
   * hardening pass exists to surface. */
  static async loadExisting(filePath: string = DEFAULT_AUDIT_LOG_PATH): Promise<JsonFileAuditTrail> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new JsonFileAuditTrail(filePath, []);
      }
      throw new AuditTrailPersistenceError(filePath, `could not read existing audit log: ${toErrorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AuditTrailCorruptionError(filePath, `not valid JSON (${toErrorMessage(error)})`);
    }
    if (!Array.isArray(parsed)) {
      throw new AuditTrailCorruptionError(filePath, `expected a JSON array of audit events, found ${typeof parsed}`);
    }

    return new JsonFileAuditTrail(filePath, parsed as AuditEvent[]);
  }

  async record(event: AuditEvent): Promise<void> {
    await super.record(event);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.writeAtomically();
    } catch (error) {
      logger.error("Failed to persist Hermes execution audit trail", {
        component: "hermes-execution",
        filePath: this.filePath,
        error: toErrorMessage(error),
      });
      throw error instanceof AuditTrailPersistenceError ? error : new AuditTrailPersistenceError(this.filePath, toErrorMessage(error));
    } finally {
      release();
    }
  }

  private async writeAtomically(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Unique per attempt (random, not just pid — two attempts in the SAME process are already
    // serialized by writeLock above, but a unique name per attempt is what keeps a genuinely
    // concurrent SECOND PROCESS's own temp file from ever colliding with this one) so two
    // independent writers never clobber each other's in-progress temp file — only the final
    // rename can "lose," never a half-written destination file.
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(tempPath, "w");
    } catch (error) {
      throw new AuditTrailPersistenceError(this.filePath, `could not create temp file: ${toErrorMessage(error)}`);
    }
    try {
      await handle.writeFile(JSON.stringify(this.events, null, 2), "utf-8");
      // Flush to physical storage before the rename below — not just the OS's in-memory write
      // buffer — so a crash immediately after this call still leaves complete data on disk.
      await handle.sync();
    } catch (error) {
      throw new AuditTrailPersistenceError(this.filePath, `could not write temp file: ${toErrorMessage(error)}`);
    } finally {
      await handle.close();
    }
    try {
      // Atomic on POSIX filesystems when source and destination are on the same volume (true here
      // — the temp file is always written alongside its own destination): the destination path
      // either still shows the prior complete file, or the new complete file, never a mix.
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw new AuditTrailPersistenceError(this.filePath, `could not rename temp file into place: ${toErrorMessage(error)}`);
    }
  }
}
