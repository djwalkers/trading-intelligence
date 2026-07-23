-- Phase 4 — Trade Performance Engine
--
-- One row per CLOSED TradeLifecycleRecord (Milestone 6) — the durable, queryable measurement of
-- how a trade actually performed, independent of whether the decision that led to it was good or
-- bad by any other measure. This is a NEW, purely observational capability: it measures trades
-- after they close, it never influences MarketDecisionEngine, a Strategy, PortfolioRiskEngine, the
-- broker, the runtime scheduler, indicators, or the trade approval workflow (see
-- src/lib/hermes-execution/trade-performance/trade-performance-service.ts's own top-of-file
-- comment for exactly how a row here gets written).
--
-- Written exclusively by the standalone Hermes trading-runtime process (service-role client +
-- HERMES_SUPABASE_USER_ID — the same pattern market_analysis_runs/trade_candidates already
-- established), the moment a SELL trade candidate's execution closes a TradeLifecycleRecord. Read
-- by this app's own Performance Analytics page (anon-key client + the signed-in user's session,
-- RLS-scoped — the same "safe to construct and use directly in the browser" pattern
-- trade_candidates already established).

create table if not exists trade_performance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- TradeLifecycleRecord.id (e.g. "trade-lifecycle-3") — the one stable identifier this whole
  -- pipeline already assigns to a single open-to-close position lifecycle. Not a uuid: it's an
  -- app-generated string from the (in-memory, per-process) TradeLifecycleService, the same
  -- "app-generated string, not a uuid" convention market_analysis_runs.trade_id already documents.
  trade_id text not null,

  -- Best-effort cross-references — nullable for the same reason trade_candidates.analysis_run_id
  -- is: both upstream layers are themselves best-effort/in-memory and can be legitimately missing.
  analysis_run_id uuid references market_analysis_runs (id) on delete set null,
  candidate_id uuid references trade_candidates (id) on delete set null,

  strategy_id text not null,
  strategy_version integer not null,
  instrument text not null,
  side text not null check (side in ('BUY', 'SELL')),

  entry_time timestamptz not null,
  entry_price numeric not null,
  exit_time timestamptz not null,
  exit_price numeric not null,
  holding_time_ms numeric not null,

  gross_pnl numeric not null,
  fees numeric not null default 0,
  net_pnl numeric not null,
  return_percent numeric not null,

  -- Null when no originating BUY-side risk (stop-loss) is known for this trade — e.g. the
  -- candidate a SELL closed against could not be resolved. Never fabricated as 0.
  risk_multiple numeric,

  max_favourable_excursion numeric not null default 0,
  max_adverse_excursion numeric not null default 0,
  -- peak_profit === max_favourable_excursion, stored under its own, dashboard-friendlier name.
  -- maximum_drawdown = how much of that peak was given back before the trade closed
  -- (peak_profit - net_pnl, floored at 0) — a *per-trade* "profit given back" figure, distinct
  -- from a strategy-level equity-curve drawdown (see trade-performance-analytics.ts's own
  -- computeMaxDrawdown for that separate, portfolio-level concept). Approximated from entry/exit/
  -- MFE/MAE snapshots only — this pipeline does not retain a full intra-trade price path (see
  -- trade-performance-service.ts's own doc comment).
  peak_profit numeric not null default 0,
  maximum_drawdown numeric not null default 0,

  win_loss text not null check (win_loss in ('WIN', 'LOSS', 'BREAKEVEN')),
  exit_reason text,

  constraint trade_performance_user_trade_unique unique (user_id, trade_id)
);

create index if not exists trade_performance_user_exit_idx
  on trade_performance (user_id, exit_time desc);
create index if not exists trade_performance_strategy_idx
  on trade_performance (strategy_id);
create index if not exists trade_performance_instrument_idx
  on trade_performance (instrument);
create index if not exists trade_performance_win_loss_idx
  on trade_performance (win_loss);
create index if not exists trade_performance_candidate_idx
  on trade_performance (candidate_id);

alter table trade_performance enable row level security;

drop policy if exists "Users can view their own trade performance" on trade_performance;
create policy "Users can view their own trade performance"
  on trade_performance for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own trade performance" on trade_performance;
create policy "Users can insert their own trade performance"
  on trade_performance for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own trade performance" on trade_performance;
create policy "Users can update their own trade performance"
  on trade_performance for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table trade_performance is
  'Phase 4. One row per closed trade (TradeLifecycleRecord CLOSED) — objective, after-the-fact measurement of trade quality. Never read by, and never influences, MarketDecisionEngine, a Strategy, PortfolioRiskEngine, the broker, the scheduler, or the trade approval workflow.';
comment on column trade_performance.trade_id is
  'TradeLifecycleRecord.id — an app-generated string (e.g. "trade-lifecycle-3"), not a uuid. Unique per user; the natural de-duplication key for the sync step that writes this table.';
comment on column trade_performance.risk_multiple is
  'net_pnl / initial dollar risk (|entryPrice - stopLoss| x quantity), using the stop-loss recorded on the originating BUY TradeCandidate. Null when that candidate could not be resolved.';
comment on column trade_performance.maximum_drawdown is
  'Per-trade: how much of this trade''s own peak_profit was given back before it closed (peak_profit - net_pnl, floored at 0) — an approximation from entry/exit/MFE/MAE only, not a full intra-trade price path. Distinct from a strategy-level equity-curve drawdown.';
