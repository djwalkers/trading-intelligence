-- Build 0.7.0 — trade_intelligence
--
-- 1:1 extension of paper_trades for trades where source = 'Market Intelligence'. A separate
-- table rather than nullable columns on paper_trades, since most trades (Signal-sourced) will
-- never have this data. Mirrors PaperTradeIntelligenceContext.

create table if not exists trade_intelligence (
  id uuid primary key default gen_random_uuid(),
  paper_trade_id uuid not null references paper_trades (id) on delete cascade,

  recommendation text not null
    check (recommendation in ('Strong Buy', 'Buy', 'Hold', 'Avoid', 'Strong Sell')),

  -- e.g. [{ "label": "Trend", "score": 5 }, ...] — mirrors EvidenceRating[]
  evidence jsonb not null,
  evidence_factors text[] not null,
  invalidation_factors text[] not null,

  created_at timestamptz not null default now(),

  unique (paper_trade_id)
);

comment on table trade_intelligence is
  'Prototype-only (Build 0.7.0). 1:1 extension of paper_trades for Market Intelligence-sourced trades.';
