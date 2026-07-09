-- Mission 6 — Server Architecture Preparation: scheduler state
--
-- A Supabase-backed home for scheduler configuration, so a future background worker (Mission 7)
-- can read/write "should I be scanning for this user, how often, when's the next scan due" without
-- any browser tab open. Not wired into the running app yet — the browser's Bot Runner panel
-- continues to use its own localStorage-backed BotSchedulerProvider entirely unchanged (see
-- src/lib/state/bot-scheduler-context.tsx) — this table exists purely as prepared infrastructure
-- for Mission 7. One row per user (a single active schedule), matching today's one-schedule-per-
-- browser model.
--
-- interval_minutes deliberately has no "manual only" state the way the browser's local
-- SchedulerMode enum does (Manual/Every15/Every30/Every60) — a disabled row (enabled = false)
-- simply isn't acted on, so its interval doesn't need a null/manual case. This is a deliberate
-- simplification for the server schema, documented in
-- docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md.
--
-- locked_at/locked_by (concurrency protection): a worker claims this row via a conditional UPDATE
-- before scanning and clears the lock afterwards — see
-- src/lib/scheduler/server-schedule-store.ts and
-- docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md for the exact locking algorithm and
-- why it matters (preventing two concurrent scans for the same user from racing against the same
-- stale view of open positions).

create table if not exists bot_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  enabled boolean not null default false,
  interval_minutes integer not null default 30 check (interval_minutes in (15, 30, 60)),

  next_scan_at timestamptz,
  last_scan_at timestamptz,
  last_status text check (last_status is null or last_status in ('Trade Opened', 'No Trade', 'Error')),
  last_error text,

  locked_at timestamptz,
  locked_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id)
);

create index if not exists bot_schedules_next_scan_at_idx on bot_schedules (next_scan_at);

alter table bot_schedules enable row level security;

drop policy if exists "Users can view their own bot schedule" on bot_schedules;
create policy "Users can view their own bot schedule"
  on bot_schedules for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own bot schedule" on bot_schedules;
create policy "Users can insert their own bot schedule"
  on bot_schedules for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own bot schedule" on bot_schedules;
create policy "Users can update their own bot schedule"
  on bot_schedules for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table bot_schedules is
  'Prototype (Mission 6). Server-side scheduler configuration for a future background worker (Mission 7) — not read or written by the browser app yet. RLS protects a future browser-direct-access path; a service-role worker bypasses RLS entirely and must enforce user_id correctness in code (see docs/product/MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md).';
comment on column bot_schedules.locked_at is
  'Set by a worker claiming this row before scanning; cleared when the scan completes. A lock older than the timeout in server-schedule-store.ts is considered abandoned and reclaimable.';
comment on column bot_schedules.locked_by is
  'Opaque identifier of whichever worker process currently holds the lock (e.g. a hostname+pid string) — only used so a worker never releases a lock it doesn''t actually hold.';
