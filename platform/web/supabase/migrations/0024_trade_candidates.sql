-- Phase 3.5 — Trade Review & Approval
--
-- One row per BUY/SELL decision the Hermes trading-runtime process (TradingRuntime.runCycleBody,
-- src/lib/hermes-execution/runtime/trading-runtime.ts) makes — the queue of trades awaiting human
-- review. This table is now the ONLY thing standing between a decision and the broker: automatic
-- execution is off unconditionally (see trading-runtime.ts's own doc comment) — MarketDecisionEngine,
-- PortfolioRiskEngine, and the broker are all unmodified, but the runtime never calls the risk
-- engine or the broker for a fresh decision any more, only for a candidate a human already approved
-- (execution_snapshot below is what makes that possible from a later cycle).
--
-- Written by the standalone Hermes trading-runtime process (service-role client + an explicit
-- user_id from HERMES_SUPABASE_USER_ID — the same "service role + explicit userId" pattern
-- market_analysis_runs already established) when it creates a candidate or executes/expires one;
-- updated by this app's own Trade Approval page (anon-key client + the signed-in user's session,
-- RLS-scoped) when a human approves or rejects one. Both sides read/write the same table — see
-- trade-candidate-repository.ts's own top-of-file comment for why it is deliberately NOT
-- "server-only".

create table if not exists trade_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Best-effort cross-reference to market_analysis_runs.id for the same cycle (Phase 2B) — nullable
  -- because that layer is documented best-effort and can be silently missing; this row's own
  -- columns below are the durable record of "what analysis produced this candidate" regardless.
  analysis_run_id uuid references market_analysis_runs (id) on delete set null,

  strategy_id text not null,
  strategy_version integer not null,
  instrument text not null,
  direction text not null check (direction in ('BUY', 'SELL')),
  confidence numeric not null,

  entry_price numeric not null,
  stop_loss numeric not null,
  take_profit numeric not null,
  risk_reward numeric not null,

  -- MarketDecision.reasoning / .validationNotes verbatim (string arrays) — the same "why" a human
  -- reviewing this candidate on the Trade Approval page reads.
  reasoning text[] not null default '{}',
  validation_notes text[] not null default '{}',

  -- The frozen { marketContext, marketDataSnapshot, amount } a later cycle replays verbatim through
  -- the existing, unmodified runMarketDecisionCycleWithLifecycle once this candidate is APPROVED —
  -- see trade-candidate-service.ts's own executeApprovedTradeCandidate. Never re-fetched or
  -- re-derived; execution always matches exactly what was reviewed.
  execution_snapshot jsonb not null,

  expires_at timestamptz not null,

  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED')),

  approved_at timestamptz,
  approved_by_user_id uuid references auth.users (id),
  rejected_at timestamptz,
  rejected_by_user_id uuid references auth.users (id),
  rejection_reason text,
  executed_at timestamptz,
  -- The resulting TradeLifecycleRecord's own id (in-memory today — see trade-lifecycle-store.ts's
  -- own "no database implementation exists yet" comment — so this is a best-effort label, not
  -- guaranteed joinable against a persisted lifecycle table until that milestone ships one).
  lifecycle_record_id text,
  broker_order_id text,
  failure_reason text,

  constraint trade_candidates_approved_fields_together
    check ((approved_at is null) = (approved_by_user_id is null)),
  constraint trade_candidates_rejected_fields_together
    check ((rejected_at is null) = (rejected_by_user_id is null))
);

create index if not exists trade_candidates_user_created_idx
  on trade_candidates (user_id, created_at desc);
create index if not exists trade_candidates_status_idx
  on trade_candidates (status);
create index if not exists trade_candidates_strategy_instrument_idx
  on trade_candidates (strategy_id, instrument);
create index if not exists trade_candidates_expires_at_idx
  on trade_candidates (expires_at);

alter table trade_candidates enable row level security;

drop policy if exists "Users can view their own trade candidates" on trade_candidates;
create policy "Users can view their own trade candidates"
  on trade_candidates for select
  using (auth.uid() = user_id);

-- Insert is done by the standalone runtime process (service role, bypasses RLS) — this policy
-- exists anyway, matching market_analysis_runs' own "define real policies, never rely on RLS being
-- silently bypassed as the only reason writes work" discipline.
drop policy if exists "Users can insert their own trade candidates" on trade_candidates;
create policy "Users can insert their own trade candidates"
  on trade_candidates for insert
  with check (auth.uid() = user_id);

-- Update covers BOTH the runtime process (service role, sweeping expiries / recording execution
-- outcomes) AND this app's own signed-in user (approving/rejecting via the Trade Approval page) —
-- the only table in this schema genuinely written from both sides under RLS.
drop policy if exists "Users can update their own trade candidates" on trade_candidates;
create policy "Users can update their own trade candidates"
  on trade_candidates for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table trade_candidates is
  'Phase 3.5. One row per BUY/SELL decision awaiting (or having received) human review — the queue between MarketDecisionEngine''s decision and the broker. Automatic execution is off unconditionally; only an APPROVED candidate is ever executed, by a later trading-runtime cycle.';
comment on column trade_candidates.execution_snapshot is
  'Frozen { marketContext, marketDataSnapshot, amount } replayed verbatim by executeApprovedTradeCandidate — never re-fetched, so execution always matches exactly what a human reviewed.';
comment on column trade_candidates.status is
  'PENDING -> APPROVED|REJECTED|EXPIRED. APPROVED -> EXECUTED|FAILED|EXPIRED. Every other transition is invalid — see trade-approval/types.ts''s own VALID_CANDIDATE_TRANSITIONS.';
