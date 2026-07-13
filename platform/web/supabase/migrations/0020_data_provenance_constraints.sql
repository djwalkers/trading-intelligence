-- Sprint 290 — Automatic Data Provenance & Live Data Integrity
--
-- data_provenance already exists on all three tables below — added directly to the live Supabase
-- project out-of-band, with no tracked migration ever creating it. This migration is what brings
-- that column under version control and makes it impossible to write NULL going forward, without
-- silently masking a missed application-level write with a DEFAULT.
--
-- Deployment procedure for the live project (the worker is running and creating new rows right
-- now): disable Always-On Scanning; manually classify every remaining NULL row from real worker
-- evidence (each row's own decision/trace data, not a guess); confirm zero NULL rows remain in all
-- three tables; only then apply this migration; deploy the application code that writes
-- data_provenance on every new row; run one controlled, verified scan and confirm the new rows are
-- verified_external_data; only then re-enable Always-On Scanning.
--
-- `add column if not exists` (rather than a plain `add column`) is deliberate and load-bearing:
-- because the column was added manually outside tracked migrations, a plain `add column` would
-- fail outright the first time this migration runs against the live project, which already has
-- the column. The conservative NULL backfill below only ever matters for a genuinely fresh
-- environment or truly unidentifiable legacy data — the live deployment procedure ensures it is a
-- no-op against the live project by the time this migration actually runs there.
--
-- Deliberately NO `set default` on any of the three columns: a missed application-level insert
-- must fail loudly (a NOT NULL violation), never silently succeed with a guessed value.

alter table bot_decisions add column if not exists data_provenance text;
update bot_decisions set data_provenance = 'sample_data' where data_provenance is null;
alter table bot_decisions alter column data_provenance set not null;
alter table bot_decisions drop constraint if exists bot_decisions_data_provenance_check;
alter table bot_decisions add constraint bot_decisions_data_provenance_check
  check (data_provenance in ('sample_data', 'verified_external_data', 'fallback_sample_data', 'backtest'));

alter table decision_history add column if not exists data_provenance text;
update decision_history set data_provenance = 'sample_data' where data_provenance is null;
alter table decision_history alter column data_provenance set not null;
alter table decision_history drop constraint if exists decision_history_data_provenance_check;
alter table decision_history add constraint decision_history_data_provenance_check
  check (data_provenance in ('sample_data', 'verified_external_data', 'fallback_sample_data', 'backtest'));

alter table paper_trades add column if not exists data_provenance text;
update paper_trades set data_provenance = 'sample_data' where data_provenance is null;
alter table paper_trades alter column data_provenance set not null;
alter table paper_trades drop constraint if exists paper_trades_data_provenance_check;
alter table paper_trades add constraint paper_trades_data_provenance_check
  check (data_provenance in ('sample_data', 'verified_external_data', 'fallback_sample_data', 'backtest'));

comment on column bot_decisions.data_provenance is
  'Sprint 290. Where the market data behind this decision actually came from: sample_data (mock/manual scan), verified_external_data (scheduled worker, external provider, no fallback), fallback_sample_data (scheduled worker, provider fell back to sample data), backtest (future). NOT NULL, no default — a missed application write fails loudly rather than being silently guessed.';
comment on column decision_history.data_provenance is
  'Sprint 290. Inherited exactly from the originating bot_decisions.data_provenance — every candidate from one scan shares that scan''s single provenance value. NOT NULL, no default.';
comment on column paper_trades.data_provenance is
  'Sprint 290. Inherited exactly from the originating BotDecision, Signal, or Opportunity''s provenance — Signal/Opportunity-sourced trades default to sample_data, since neither flow carries a provenance concept to inherit today. NOT NULL, no default.';
