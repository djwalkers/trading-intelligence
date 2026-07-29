import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/lib/logger/logger";

// Telegram alert refinement — daily account summary. Modeled directly on
// json-file-paper-broker-store.ts's own established "small local JSON, git-ignored, degrades
// gracefully on failure rather than throwing" pattern: the ONLY thing persisted here is the
// Europe/London calendar date (e.g. "2026-07-29") the daily summary was last successfully
// delivered for — enough to survive a process restart without ever re-sending the same day's
// summary, and nothing more (never the summary's own content, never a credential).

export interface DailyAccountSummaryState {
  lastSentDate: string;
}

export interface DailyAccountSummaryStateStore {
  load(): Promise<DailyAccountSummaryState | null>;
  save(state: DailyAccountSummaryState): Promise<void>;
}

export const DEFAULT_DAILY_ACCOUNT_SUMMARY_STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "hermes-execution",
  "daily-account-summary-state.json",
);

export class JsonFileDailyAccountSummaryStateStore implements DailyAccountSummaryStateStore {
  constructor(private readonly filePath: string = DEFAULT_DAILY_ACCOUNT_SUMMARY_STATE_PATH) {}

  async load(): Promise<DailyAccountSummaryState | null> {
    try {
      const text = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(text) as DailyAccountSummaryState;
    } catch {
      return null;
    }
  }

  async save(state: DailyAccountSummaryState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (error) {
      logger.error("Failed to persist Hermes daily account summary state", {
        component: "hermes-execution",
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Test double only — no in-memory implementation is used in production, mirroring every other
 * store in this codebase's own "one real, one in-memory for tests" convention. */
export class InMemoryDailyAccountSummaryStateStore implements DailyAccountSummaryStateStore {
  private state: DailyAccountSummaryState | null = null;

  async load(): Promise<DailyAccountSummaryState | null> {
    return this.state;
  }

  async save(state: DailyAccountSummaryState): Promise<void> {
    this.state = state;
  }
}
