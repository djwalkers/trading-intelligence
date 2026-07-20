import "server-only";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/lib/logger/logger";
import type { PaperBrokerState, PaperBrokerStore } from "./paper-broker-store";

// Modeled directly on AlphaVantageHistoricalMarketDataProvider's `.data/*.json` cache pattern
// (src/lib/market-data/alpha-vantage-historical-market-data-provider.ts): a single local JSON
// file, plain fs read/write, git-ignored, degrades gracefully on failure rather than throwing —
// exactly the "small local JSON... consistent with the current project architecture" this phase
// calls for, not a new PaperTradeStore/Supabase implementation (see docs/execution-mvp-phase-1.md
// for why: that interface's shape doesn't map cleanly onto this isolated pipeline).
export const DEFAULT_PAPER_BROKER_STATE_PATH = path.join(
  process.cwd(),
  ".data",
  "hermes-execution",
  "paper-broker-state.json",
);

export class JsonFilePaperBrokerStore implements PaperBrokerStore {
  constructor(private readonly filePath: string = DEFAULT_PAPER_BROKER_STATE_PATH) {}

  async load(): Promise<PaperBrokerState | null> {
    try {
      const text = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(text) as PaperBrokerState;
    } catch {
      return null;
    }
  }

  async save(state: PaperBrokerState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (error) {
      logger.error("Failed to persist Hermes paper broker state", {
        component: "hermes-execution",
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
