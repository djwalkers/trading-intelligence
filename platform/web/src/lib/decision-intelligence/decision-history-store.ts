import type { DecisionRecord } from "./types";

// Deliberately just two operations, both append-only — a DecisionRecord is never edited or
// deleted by this mission (outcome analysis, the one thing that would ever update a record, is
// explicitly future work — see docs/product/MISSION-7-DECISION-INTELLIGENCE.md). addRecords takes
// an array, not one record at a time, since a single scan produces one DecisionRecord per
// candidate evaluated and they're always written together.
export interface DecisionHistoryStore {
  load(): Promise<DecisionRecord[]>;
  addRecords(records: DecisionRecord[]): Promise<void>;
}
