-- Phase 2B — Decision Intelligence: Historical Analysis Persistence
--
-- One row per Hermes trading-runtime scheduler cycle (TradingRuntime.runCycleBody,
-- src/lib/hermes-execution/runtime/trading-runtime.ts) — the platform's long-term analytical
-- memory of every market analysis it has ever performed, not just the ones that opened a trade.
-- This is a NEW, independent capability: it observes and records what the runtime already decided
-- (via MarketDecisionEngine, PortfolioRiskEngine, the broker) — it never influences any of that.
-- Nothing about strategy rules, indicator formulas, broker behaviour, execution logic, scheduler
-- timing, or risk logic is read, written, or gated by this table.
--
-- Written exclusively by the standalone Hermes trading-runtime process (via the service-role
-- client + an explicit user_id from HERMES_SUPABASE_USER_ID — see
-- src/lib/hermes-execution/analysis/analysis-persistence-config.ts), the same "service role +
-- explicit userId" pattern src/lib/decision-intelligence/server-decision-history-store.ts already
-- established for server-side/worker writes on behalf of a user with no browser session. Read by
-- the browser app's own Decision Intelligence page (RLS-scoped to the signed-in user, exactly like
-- paper_trades) and by the bearer-token-gated GET /api/hermes/analysis route (service role +ExplicitUserId,
-- for the Hermes Agent / external tooling).
--
-- user_id is not part of Phase 2B's own suggested schema list — added here because "Users only see
-- their own data" (this phase's own security requirement) is impossible to enforce with Postgres
-- Row Level Security without a column to scope on, exactly as every other per-user table in this
-- schema already requires (paper_trades, decision_history, research is the one deliberate
-- exception because it's global reference data — this table is not).

create table if not exists market_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- Pipeline configuration this cycle ran under (HermesExecutionConfig at the time) — lets a
  -- future query separate "what happened under live vs. mock data" or "under which broker"
  -- without cross-referencing deployment logs.
  runtime_mode text not null check (runtime_mode in ('paper', 'demo', 'testnet')),
  broker_provider text not null check (broker_provider in ('local', 'hyperliquid-testnet', 'trading212-demo', 'etoro-demo')),
  market_provider text not null check (market_provider in ('mock', 'live')),

  instrument text not null,
  timeframe text not null,
  strategy_id text not null,
  strategy_version integer not null,

  -- Market snapshot this cycle observed (MarketDecisionContext / MarketDiagnosticsResult's own
  -- shape — see docs/market-diagnostics-phase-2a1.md for the same fields' meaning).
  current_bid numeric,
  current_ask numeric,
  current_mid numeric,
  last_close numeric,

  -- Indicators as MarketIntelligenceBuilder computed them this cycle (technical-indicators.ts,
  -- unmodified) — recorded, never recalculated or second-guessed here.
  ema20 numeric,
  ema50 numeric,
  rsi14 numeric,
  atr14 numeric,
  trend text check (trend is null or trend in ('Bullish', 'Bearish', 'Sideways')),

  -- MarketDecisionEngine's own, unmodified output for this cycle.
  confidence numeric,
  decision text not null check (decision in ('BUY', 'SELL', 'HOLD', 'ERROR')),
  -- Human-readable, joined form of MarketDecision.reasoning (a string[]) — the full array is also
  -- preserved losslessly in metadata->>'reasoning' for anything that needs the individual items.
  decision_reason text,

  executed_trade boolean not null default false,
  -- The broker's own position/trade id (EtoroDemoBroker's PaperPosition.positionId /
  -- CompletedTrade.tradeId — an app-generated string, e.g. "etoro-position-42", not a uuid), so
  -- this row can be cross-referenced against the broker's own trade lifecycle records. Null
  -- whenever executed_trade is false.
  trade_id text,

  -- Data-quality signals this cycle observed — mirrors market_diagnostics_result.validation
  -- (Phase 2A.1) exactly, so the two features report data quality identically.
  validation_ok boolean not null default true,
  fallback_used boolean not null default false,
  candle_count integer,
  data_age_seconds numeric,

  -- How long this whole scheduler cycle took, wall-clock — an operational/performance signal,
  -- never fed back into scheduler timing itself.
  runtime_duration_ms numeric,

  error_code text,
  error_message text,

  -- Catch-all for anything not worth its own column yet (the full reasoning array, blockedReasons
  -- from PortfolioRiskEngine, the trigger type, etc.) — see AnalysisRunInput.metadata's own doc
  -- comment (src/lib/hermes-execution/analysis/types.ts) for exactly what's stored here today.
  metadata jsonb not null default '{}'::jsonb,

  constraint market_analysis_runs_trade_id_requires_executed
    check (trade_id is null or executed_trade = true)
);

create index if not exists market_analysis_runs_user_created_idx
  on market_analysis_runs (user_id, created_at desc);
create index if not exists market_analysis_runs_created_at_idx
  on market_analysis_runs (created_at desc);
create index if not exists market_analysis_runs_instrument_idx
  on market_analysis_runs (instrument);
create index if not exists market_analysis_runs_strategy_id_idx
  on market_analysis_runs (strategy_id);
create index if not exists market_analysis_runs_decision_idx
  on market_analysis_runs (decision);
create index if not exists market_analysis_runs_executed_trade_idx
  on market_analysis_runs (executed_trade);

alter table market_analysis_runs enable row level security;

drop policy if exists "Users can view their own market analysis runs" on market_analysis_runs;
create policy "Users can view their own market analysis runs"
  on market_analysis_runs for select
  using (auth.uid() = user_id);

-- Insert/update both use the service-role client in practice (only the Hermes trading-runtime
-- process ever writes this table — see this file's own top-of-file comment), which bypasses RLS
-- entirely. These policies exist anyway, matching decision_history's own "define real policies,
-- never rely on RLS being silently bypassed as the only reason writes work" discipline — a future
-- browser-side write path (there isn't one today; the UI is read-only per Phase 2B's own
-- requirement) would already be safely scoped without a further migration.
drop policy if exists "Users can insert their own market analysis runs" on market_analysis_runs;
create policy "Users can insert their own market analysis runs"
  on market_analysis_runs for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own market analysis runs" on market_analysis_runs;
create policy "Users can update their own market analysis runs"
  on market_analysis_runs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table market_analysis_runs is
  'Phase 2B. One row per Hermes trading-runtime scheduler cycle — the platform''s full historical analysis record, independent of whether a trade executed. Read-only from a strategy perspective: written after a cycle''s decision/execution already happened, never influences it.';
comment on column market_analysis_runs.decision is
  'BUY/SELL/HOLD from MarketDecisionEngine, or ERROR when the cycle failed before a decision could be made (see error_code/error_message).';
comment on column market_analysis_runs.trade_id is
  'The broker''s own position/trade id (an app-generated string, not a uuid) — null unless executed_trade is true.';
comment on column market_analysis_runs.fallback_used is
  'Always false today — no fallback path exists anywhere in this pipeline (see LiveMarketDataProvider''s own doc comments). Recorded per-row for audit completeness and forward compatibility, not because it currently varies.';
