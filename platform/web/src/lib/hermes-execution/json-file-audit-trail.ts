import "server-only";
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

/** Same local-JSON-file pattern as JsonFilePaperBrokerStore. Each demo run starts a fresh log
 * (see `createFresh`) so the persisted file always reflects the most recent full replay, not an
 * ever-growing history — the system-health panel reads this file to answer "what happened last". */
export class JsonFileAuditTrail extends InMemoryAuditTrail {
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

  static async loadExisting(filePath: string = DEFAULT_AUDIT_LOG_PATH): Promise<JsonFileAuditTrail> {
    try {
      const text = await fs.readFile(filePath, "utf-8");
      const events = JSON.parse(text) as AuditEvent[];
      return new JsonFileAuditTrail(filePath, events);
    } catch {
      return new JsonFileAuditTrail(filePath, []);
    }
  }

  async record(event: AuditEvent): Promise<void> {
    await super.record(event);
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.events, null, 2), "utf-8");
    } catch (error) {
      logger.error("Failed to persist Hermes execution audit trail", {
        component: "hermes-execution",
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
