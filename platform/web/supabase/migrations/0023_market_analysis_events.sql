-- Phase 2B — Decision Intelligence: Historical Analysis Persistence (timeline events)
--
-- Fine-grained timeline events within one market_analysis_runs row's own cycle — e.g.
-- MARKET_DATA_FETCHED, INDICATORS_CALCULATED, DECISION_COMPLETED, EXECUTION_STARTED,
-- EXECUTION_SKIPPED, ERROR. Deliberately NOT constrained to a closed enum of event types (unlike
-- market_analysis_runs.decision/trend, which are genuinely closed sets) — see AnalysisEventType
-- (src/lib/hermes-execution/analysis/types.ts) for the current TypeScript-level vocabulary, kept
-- open here so a future event type never needs a migration of its own. severity is the one field
-- that IS a closed set, since UI filtering/styling depends on it staying small and stable.
--
-- Same writer/reader split as market_analysis_runs (see that migration's own top-of-file comment):
-- written by the Hermes trading-runtime process via the service-role client, read by the browser
-- app (RLS) and the bearer-token-gated API route (service role).

create table if not exists market_analysis_events (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references market_analysis_runs (id) on delete cascade,

  "timestamp" timestamptz not null default now(),
  event_type text not null,
  severity text not null default 'info' check (severity in ('debug', 'info', 'warn', 'error')),
  message text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists market_analysis_events_run_id_idx
  on market_analysis_events (analysis_run_id, "timestamp");
create index if not exists market_analysis_events_event_type_idx
  on market_analysis_events (event_type);

alter table market_analysis_events enable row level security;

-- No user_id column of its own — scoped via a join back to market_analysis_runs.user_id, exactly
-- matching trade_events' own established convention (0007_user_scoped_row_level_security.sql).

drop policy if exists "Users can view events for their own analysis runs" on market_analysis_events;
create policy "Users can view events for their own analysis runs"
  on market_analysis_events for select
  using (
    exists (
      select 1 from market_analysis_runs
      where market_analysis_runs.id = market_analysis_events.analysis_run_id
        and market_analysis_runs.user_id = auth.uid()
    )
  );

drop policy if exists "Users can insert events for their own analysis runs" on market_analysis_events;
create policy "Users can insert events for their own analysis runs"
  on market_analysis_events for insert
  with check (
    exists (
      select 1 from market_analysis_runs
      where market_analysis_runs.id = market_analysis_events.analysis_run_id
        and market_analysis_runs.user_id = auth.uid()
    )
  );

comment on table market_analysis_events is
  'Phase 2B. Fine-grained timeline events within one market_analysis_runs cycle (e.g. MARKET_DATA_FETCHED, DECISION_COMPLETED, ERROR) — the detailed audit trail behind each summary row.';
comment on column market_analysis_events.event_type is
  'Open vocabulary (see AnalysisEventType in src/lib/hermes-execution/analysis/types.ts) — not a database-level enum, so a new event type never needs a migration.';
