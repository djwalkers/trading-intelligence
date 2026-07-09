-- Mission 6 — Server Architecture Preparation: server-side decision log
--
-- A Supabase-backed home for bot decisions produced by a future background worker (Mission 7). The
-- browser's own decision log (src/lib/state/bot-decision-log-context.tsx) remains entirely
-- local-browser-only and unchanged — a worker has no browser to log into, so its decisions need
-- somewhere to go if they're going to be auditable at all. Not read or written by the browser app
-- yet; no UI reads this table as of this migration (a future mission could extend the Bot Decisions
-- page to merge local + server-side history).
--
-- The full BotDecision object (candidates, trace, portfolio snapshot) is stored as one jsonb
-- column rather than modelled relationally — mirrors exactly what's already serialized to
-- localStorage today, and paper_trades.portfolio_exposure_snapshot already established the same
-- jsonb-for-nested-structure pattern (Mission 2).

create table if not exists bot_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  scan_id text not null,
  trigger_type text not null check (trigger_type in ('Manual', 'Scheduled')),
  action_taken text not null check (action_taken in ('Trade Opened', 'No Trade')),
  reason text not null,
  decision jsonb not null,

  created_paper_trade_id uuid references paper_trades (id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists bot_decisions_user_id_created_at_idx
  on bot_decisions (user_id, created_at desc);

alter table bot_decisions enable row level security;

drop policy if exists "Users can view their own bot decisions" on bot_decisions;
create policy "Users can view their own bot decisions"
  on bot_decisions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own bot decisions" on bot_decisions;
create policy "Users can insert their own bot decisions"
  on bot_decisions for insert
  with check (auth.uid() = user_id);

comment on table bot_decisions is
  'Prototype (Mission 6). Server-side decision log for a future background worker (Mission 7) — not read or written by the browser app yet. Append-only, like trade_events: no update/delete policies.';
comment on column bot_decisions.decision is
  'The full BotDecision object (candidates, trace, portfolio snapshot) as jsonb — mirrors the shape already stored client-side in localStorage today.';
