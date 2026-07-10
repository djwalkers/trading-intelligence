-- Mission 11 — Outcome Analysis v1
--
-- Extends decision_history (0016) with the fields outcome analysis needs to classify a completed
-- Bot trade's linked decision as Win/Loss/Neutral once it closes. All nullable — every existing
-- row (including Pending rows already written by real scans and worker reconciliation runs from
-- Mission 10) is left completely untouched until a linked closed trade actually proves an outcome.
-- The outcome column itself already allowed 'Win'/'Loss'/'Neutral' (Mission 7's own check
-- constraint), so no constraint change is needed there — only new columns to record the evidence
-- behind a classification.

alter table decision_history
  add column if not exists realised_pnl numeric,
  add column if not exists realised_pnl_percent numeric,
  add column if not exists holding_duration_minutes integer,
  add column if not exists closed_at timestamptz,
  add column if not exists outcome_recorded_at timestamptz;

comment on column decision_history.realised_pnl is
  'GBP realised P/L of the linked paper trade at close, copied here once outcome analysis runs (Mission 11). Null until then, and always null for Rejected decisions.';
comment on column decision_history.realised_pnl_percent is
  'Realised P/L as a percentage of entry notional, same timing as realised_pnl (Mission 11).';
comment on column decision_history.holding_duration_minutes is
  'Minutes between the linked trade opening (this record''s own decided_at) and its closed_at (Mission 11).';
comment on column decision_history.closed_at is
  'The linked paper trade''s own closed_at, copied here so an outcome record is self-contained without a join back to paper_trades (Mission 11).';
comment on column decision_history.outcome_recorded_at is
  'When outcome analysis actually classified this record — distinct from closed_at (the trade''s own close time), since reconciliation can run some time after a trade closes (Mission 11).';

-- Data-integrity guarantee for requirement 8 ("one decision record links to at most one created
-- trade"): a partial unique index, since created_trade_id is null for every Rejected decision and
-- Postgres unique indexes already permit unlimited NULLs — only non-null values (i.e. trades that
-- were actually opened) are constrained to appear in at most one decision_history row.
create unique index if not exists decision_history_created_trade_id_unique_idx
  on decision_history (created_trade_id)
  where created_trade_id is not null;
