-- Phase 2 — Research Import (First Hermes Lab Integration)
--
-- Imported Hermes Lab research runs — evidence ingestion only, no ranking, no optimisation, no AI,
-- no broker/paper-trade integration. One row per completed run-id, written exclusively by the
-- standalone `npm run import-research-run` CLI script (src/research-import/import-research-run.ts),
-- never by the browser app. Read by three new browser pages (/research, /research/[runId],
-- /research/strategies), which is why — unlike market_universe_symbols, the closest precedent for
-- "global, non-per-user reference data" — this table needs a browser-facing SELECT policy, not
-- service-role-only default-deny.
--
-- raw_run_json preserves the complete, unmodified source run.json regardless of which fields are
-- promoted to their own columns below, so a future Hermes Lab run.json revision that adds fields
-- this importer doesn't yet know about never loses data — the importer's own parser is required to
-- ignore unknown fields rather than fail (see parse-run-json.ts).

create table if not exists research_runs (
  id uuid primary key default gen_random_uuid(),

  -- Hermes Lab's own <run-id> (the research-runs/<run-id>/ folder name) — the source of truth for
  -- re-import idempotency, distinct from this table's own synthetic uuid primary key.
  run_id text not null unique,

  symbol text not null,
  strategy_name text not null,
  model text not null,
  status text not null,
  verdict text not null,
  verdict_reason text not null,
  data_source text not null,
  date_range_start date,
  date_range_end date,

  hypothesis text not null,
  falsification_criterion text not null,

  results_v1 jsonb not null,
  results_v2 jsonb not null,
  -- Computed by the importer (compute-results-diff.ts) as a key-by-key numeric diff of
  -- results_v1/results_v2 — never parsed out of comparison_markdown, which is free-form prose.
  results_diff jsonb not null,

  hypothesis_markdown text not null,
  comparison_markdown text not null,

  -- The full, unmodified run.json — see header comment above.
  raw_run_json jsonb not null,
  -- Mirrors DECISION_RECORD_SCHEMA_VERSION's existing precedent (src/lib/decision-intelligence/
  -- types.ts) — bumped if this table's own promoted-column shape is ever reinterpreted, not tied to
  -- Hermes Lab's own run.json version.
  schema_version integer not null default 1,

  -- The run's own creation time (from run.json), distinct from when this specific import happened.
  run_created_at timestamptz not null,
  imported_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_runs_strategy_name_idx
  on research_runs (strategy_name, run_created_at desc);

-- Global, non-per-user catalogue, but genuinely read by the browser (three new pages) — unlike
-- market_universe_symbols' service-role-only default-deny, a SELECT policy is required here. No
-- insert/update/delete policy: only the service-role importer ever writes, exactly as the app's
-- own single-tenant-via-Supabase-Auth model already treats every signed-in user as a trusted
-- operator of this prototype (no per-org/per-user ownership concept applies to a shared research
-- catalogue).
alter table research_runs enable row level security;

drop policy if exists "Authenticated users can view research runs" on research_runs;
create policy "Authenticated users can view research runs"
  on research_runs for select
  to authenticated
  using (true);

comment on table research_runs is
  'Phase 2. Imported Hermes Lab research runs — evidence ingestion only, no ranking/optimisation/AI. One row per completed run-id; raw_run_json preserves the full source file for forward compatibility. Written only by the service-role import CLI; readable by any authenticated user.';
comment on column research_runs.run_id is
  'Hermes Lab''s own <run-id> (the research-runs/<run-id>/ folder name). Unique — re-running the importer for the same run-id upserts rather than duplicating.';
comment on column research_runs.results_diff is
  'Computed by the importer as a key-by-key numeric diff of results_v1/results_v2 — never parsed from comparison_markdown, which is free-form prose for human reading.';
comment on column research_runs.raw_run_json is
  'The complete, unmodified run.json as imported — preserves any field not promoted to its own column, so a future Hermes Lab schema revision never loses data even before this importer is updated to read it.';
comment on column research_runs.schema_version is
  'This table''s own promoted-column schema version (mirrors DECISION_RECORD_SCHEMA_VERSION''s precedent) — not Hermes Lab''s run.json version.';
