// Sprint 290 — where the data behind one bot_decisions/decision_history/paper_trades row actually
// came from, so production reporting and future Hermes training can automatically tell real
// production signal apart from sample/mock data. The only four values a "data_provenance" column
// may ever hold — see supabase/migrations/0020_data_provenance_constraints.sql's CHECK constraint,
// which enforces this same set at the database layer as a backstop to this type.
export type DataProvenance =
  | "sample_data"
  | "verified_external_data"
  | "fallback_sample_data"
  | "backtest";
