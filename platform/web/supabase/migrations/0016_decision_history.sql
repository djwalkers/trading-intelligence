-- Mission 7 — Decision Intelligence Foundation
--
-- The bot's long-term analytical memory: one row per candidate a bot scan evaluated, accepted or
-- rejected alike, not just the one candidate (if any) that went on to open a paper trade. This is
-- deliberately NOT a duplicate of paper_trades — a PaperTrade only ever exists for a trade that
-- actually opened; decision_history exists so a future Hermes build can learn from what didn't
-- happen too (a rejected candidate's confidence, agreement, and why it was rejected), not only
-- from what did. See docs/product/MISSION-7-DECISION-INTELLIGENCE.md for the full design.
--
-- Read and written directly by the browser app (via SupabaseDecisionHistoryStore), unlike Mission
-- 6's bot_schedules/bot_decisions tables, which remain dormant/worker-only. version records the
-- DecisionRecord schema version the row was written under (DECISION_RECORD_SCHEMA_VERSION,
-- src/lib/decision-intelligence/types.ts), so a future Hermes build can evolve the shape without
-- guessing what an older row means.

create table if not exists decision_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  client_record_id text not null,
  version integer not null default 1,

  scan_id text not null,
  source_decision_id text not null,
  decided_at timestamptz not null,
  trigger_type text not null check (trigger_type in ('Manual', 'Scheduled')),
  rank integer not null,

  instrument_symbol text not null,
  instrument_name text not null,
  sector text not null,
  side text not null check (side in ('BUY', 'SELL')),
  entry_price numeric,

  strategy_used text not null,
  agreement text not null check (
    agreement in ('Strong Agreement', 'Moderate Agreement', 'Mixed Signals', 'Conflict')
  ),
  confidence numeric not null,
  evidence_summary text not null,

  deployed_capital numeric not null,
  available_cash numeric not null,
  sector_exposure numeric not null,
  total_open_trades integer not null,

  action_taken text not null check (action_taken in ('Trade Opened', 'Rejected')),
  rejection_reason text,
  position_action text check (
    position_action is null
    or position_action in ('NEW_POSITION', 'ADD_TO_POSITION', 'HOLD_POSITION', 'BLOCK_POSITION')
  ),
  portfolio_risk_result text not null check (
    portfolio_risk_result in ('Passed', 'Failed', 'Not evaluated')
  ),

  -- Deliberately just 'Pending' today (default) — outcome analysis (Win/Loss/Neutral) is explicit
  -- future work, not built by this mission. The update policy below exists so that future work
  -- doesn't need a fresh migration just to gain permission to write to this column.
  outcome text not null default 'Pending' check (outcome in ('Pending', 'Win', 'Loss', 'Neutral')),

  created_trade_id text,

  created_at timestamptz not null default now()
);

create index if not exists decision_history_user_id_decided_at_idx
  on decision_history (user_id, decided_at desc);

alter table decision_history enable row level security;

drop policy if exists "Users can view their own decision history" on decision_history;
create policy "Users can view their own decision history"
  on decision_history for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own decision history" on decision_history;
create policy "Users can insert their own decision history"
  on decision_history for insert
  with check (auth.uid() = user_id);

-- Not used by anything this mission (outcome always defaults to 'Pending' on insert) — included
-- now so a future outcome-analysis mission can update outcome without a schema/RLS migration of
-- its own.
drop policy if exists "Users can update their own decision history" on decision_history;
create policy "Users can update their own decision history"
  on decision_history for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table decision_history is
  'Mission 7. One row per candidate a bot scan evaluated (accepted or rejected), for long-term analytical history — not the same thing as paper_trades, which only records trades that actually opened.';
comment on column decision_history.version is
  'DecisionRecord schema version at write time (see DECISION_RECORD_SCHEMA_VERSION) — lets a future Hermes build evolve the shape safely.';
comment on column decision_history.outcome is
  'Pending until a future mission implements outcome analysis (Win/Loss/Neutral) — not evaluated by this mission.';
