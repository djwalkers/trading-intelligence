import type { DecisionRecord } from "./types";
import type { OutcomeUpdate } from "./outcome-analysis";

// addRecords is append-only — a DecisionRecord is never edited or deleted at creation time, one
// call per scan since a single scan produces one record per candidate evaluated. updateOutcomes
// (Mission 11) is the one exception: a targeted, idempotent update of specific fields on specific
// existing rows (never an insert, never a delete), once outcome analysis has classified a linked
// trade's close — see outcome-analysis.ts for the classification logic itself.
export interface DecisionHistoryStore {
  load(): Promise<DecisionRecord[]>;
  addRecords(records: DecisionRecord[]): Promise<void>;
  updateOutcomes(updates: OutcomeUpdate[]): Promise<void>;
}
