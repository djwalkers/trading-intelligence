import type { DecisionRecord } from "./types";
import type { DecisionHistoryStore } from "./decision-history-store";

const STORAGE_KEY = "trading-intelligence.decision-history.v1";
// A single scan can produce one record per candidate (up to the whole watchlist), several times
// more entries per scan than the Bot Decisions log's one-row-per-scan — capped generously higher
// than that log's 50 so a reasonable amount of local-mode history survives, while still bounding
// localStorage growth across a long prototype session.
const MAX_ENTRIES = 500;

export class LocalStorageDecisionHistoryStore implements DecisionHistoryStore {
  async load(): Promise<DecisionRecord[]> {
    if (typeof window === "undefined") return [];

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];
      return JSON.parse(stored) as DecisionRecord[];
    } catch {
      // Corrupt or inaccessible storage — start from an empty history.
      return [];
    }
  }

  async addRecords(records: DecisionRecord[]): Promise<void> {
    if (typeof window === "undefined") return;
    const current = await this.load();
    const next = [...records, ...current].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
}
