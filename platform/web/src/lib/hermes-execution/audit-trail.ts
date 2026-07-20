import { logger } from "@/lib/logger/logger";
import { at } from "./array-utils";
import type { AuditEvent } from "./types";

export interface AuditTrail {
  record(event: AuditEvent): Promise<void>;
  getEvents(): Promise<AuditEvent[]>;
  getLatestEvent(): Promise<AuditEvent | null>;
}

/** Base in-memory implementation; JsonFileAuditTrail (server-only) extends this with persistence.
 * Every record() call also emits a structured `logger` line — never secrets, only ids/types/values
 * already present on the event (see types.ts's AuditEvent — there is no field for credentials). */
export class InMemoryAuditTrail implements AuditTrail {
  protected events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
    logger.info(`Hermes execution event: ${event.eventType}`, {
      component: "hermes-execution",
      strategyId: event.strategyId,
      instrument: event.instrument,
      executionRunId: event.executionRunId,
      ...event.details,
    });
  }

  async getEvents(): Promise<AuditEvent[]> {
    return [...this.events];
  }

  async getLatestEvent(): Promise<AuditEvent | null> {
    return this.events.length > 0 ? at(this.events, this.events.length - 1) : null;
  }
}
