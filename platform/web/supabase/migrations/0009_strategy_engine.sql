-- Build 1.3.0 — Strategy Engine metadata on paper_trades
--
-- Records the Strategy Engine's verdict at the moment a Market-Intelligence-sourced trade was
-- placed. All four columns are nullable and purely informational — never required for P/L math
-- — so Signal-sourced trades (which don't run through the engine) and every trade placed before
-- this migration simply have them as null.

alter table paper_trades
  add column if not exists primary_strategy text,
  add column if not exists strategy_agreement text
    check (
      strategy_agreement is null
      or strategy_agreement in ('Strong Agreement', 'Moderate Agreement', 'Mixed Signals', 'Conflict')
    ),
  add column if not exists overall_confidence numeric
    check (overall_confidence is null or (overall_confidence >= 0 and overall_confidence <= 100)),
  add column if not exists evidence_summary text;

comment on column paper_trades.primary_strategy is
  'Name of the highest-confidence strategy for this instrument at the moment the trade was placed (Build 1.3.0). Null for Signal-sourced trades and trades placed before this migration.';
comment on column paper_trades.strategy_agreement is
  'Strategy Engine agreement level at trade time — Strong Agreement / Moderate Agreement / Mixed Signals / Conflict (Build 1.3.0).';
comment on column paper_trades.overall_confidence is
  'Strategy Engine overall confidence (0-100) at trade time (Build 1.3.0) — distinct from signal_confidence, which predates the engine and is shared with Signal-sourced trades.';
comment on column paper_trades.evidence_summary is
  'One-line explanation of the agreement level at trade time (Build 1.3.0), e.g. why strategies agreed or disagreed.';
