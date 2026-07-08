-- Mission 2 — Portfolio Risk Manager v1
--
-- Adds three nullable columns recording the Portfolio Risk Manager's outcome for a Bot-sourced
-- trade: whether portfolio-level risk passed (always "Passed" in practice, since a trade is only
-- ever created after every check passes — kept as a status rather than a bare boolean in case a
-- future mission persists a rejected attempt), a one-line summary of the six portfolio risk
-- checks, and a full jsonb snapshot of portfolio exposure immediately before this trade was added
-- (open trade count, capital deployed, available cash, and exposure by instrument/side/sector).
-- All three purely informational, never read by any P/L calculation — every trade placed before
-- this migration is unaffected.

alter table paper_trades
  add column if not exists portfolio_risk_status text,
  add column if not exists portfolio_risk_summary text,
  add column if not exists portfolio_exposure_snapshot jsonb;

alter table paper_trades drop constraint if exists paper_trades_portfolio_risk_status_check;
alter table paper_trades add constraint paper_trades_portfolio_risk_status_check
  check (portfolio_risk_status is null or portfolio_risk_status in ('Passed', 'Failed'));

comment on column paper_trades.portfolio_risk_status is
  'Whether the Portfolio Risk Manager''s checks passed for this trade (Mission 2). Null for Signal/Market-Intelligence trades and for Bot trades placed before this migration.';
comment on column paper_trades.portfolio_risk_summary is
  'One-line summary of the six portfolio-level risk checks evaluated for this trade (Mission 2). Null for Signal/Market-Intelligence trades.';
comment on column paper_trades.portfolio_exposure_snapshot is
  'Snapshot of portfolio exposure (open trades, capital deployed, available cash, exposure by instrument/side/sector) immediately before this trade was added (Mission 2). Null for Signal/Market-Intelligence trades.';
