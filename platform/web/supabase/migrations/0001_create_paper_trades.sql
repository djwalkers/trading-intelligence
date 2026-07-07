-- Build 0.7.0 — paper_trades
--
-- Core table: one row per paper trade, open or closed. Mirrors
-- platform/web/src/lib/types/paper-trade.ts (PaperTrade).
--
-- Requires pgcrypto (or Supabase's built-in gen_random_uuid()) for UUID generation.
-- Not yet queried by the app — see docs/database/SUPABASE-SETUP.md before running this
-- against a real project, and docs/product/BUILD-0.7.0.md for what this build does and
-- does not change in the running app.

create table if not exists paper_trades (
  id uuid primary key default gen_random_uuid(),

  -- The client-generated id already used today (e.g. "trade-sig-001-1783433805852").
  -- Kept as a unique column so existing localStorage trades can be imported later without
  -- regenerating ids, and so the client can remain the source of truth for trade identity.
  client_trade_id text not null unique,

  instrument_symbol text not null,
  instrument_name text not null,
  side text not null check (side in ('BUY', 'SELL')),
  quantity numeric not null check (quantity > 0),
  entry_price numeric not null check (entry_price >= 0),

  status text not null check (status in ('Open', 'Closed')),
  source text not null check (source in ('Signal', 'Market Intelligence')),

  strategy_name text not null,
  reason text not null,
  signal_confidence numeric not null check (signal_confidence >= 0 and signal_confidence <= 100),

  -- Present when source = 'Signal' / 'Market Intelligence' respectively. Not a foreign key —
  -- signals and opportunities are mock/generated data today, not rows in another table.
  source_signal_id text,
  source_opportunity_id text,

  -- Populated only once status = 'Closed'.
  exit_price numeric check (exit_price is null or exit_price >= 0),
  closed_at timestamptz,
  realised_pnl numeric,
  realised_pnl_percent numeric,

  opened_at timestamptz not null, -- maps to PaperTrade.timestamp
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table paper_trades is
  'Prototype-only (Build 0.7.0). One row per paper trade, open or closed. Not yet written to by the app — see docs/database/SUPABASE-SETUP.md.';
