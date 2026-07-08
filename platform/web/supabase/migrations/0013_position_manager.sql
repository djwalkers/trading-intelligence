-- Mission 3 — Position Manager v1
--
-- Adds four nullable columns recording the Position Manager's classification for a Bot-sourced
-- trade against any existing position in the same instrument: the action taken (NEW_POSITION or
-- ADD_TO_POSITION — HOLD_POSITION/BLOCK_POSITION never produce a trade, so those two values are
-- never actually written by this app, but are still valid per the check constraint below in case
-- a future mission persists a rejected attempt), the existing position's value and the value after
-- this trade (both GBP, for audit purposes only), and a one-line reason. All four purely
-- informational, never read by any P/L calculation — every trade placed before this migration is
-- unaffected.
--
-- Columns are added before the check constraint that references them — migration 0012 originally
-- had this backwards (constraint before column), which fails with "column does not exist" in
-- Postgres. Fixed there; not repeated here.

alter table paper_trades
  add column if not exists position_action text,
  add column if not exists existing_position_value numeric,
  add column if not exists position_value_after_trade numeric,
  add column if not exists position_decision_reason text;

alter table paper_trades drop constraint if exists paper_trades_position_action_check;
alter table paper_trades add constraint paper_trades_position_action_check
  check (
    position_action is null
    or position_action in ('NEW_POSITION', 'ADD_TO_POSITION', 'HOLD_POSITION', 'BLOCK_POSITION')
  );

comment on column paper_trades.position_action is
  'How the Position Manager classified this trade against any existing position in the same instrument (Mission 3). In practice always NEW_POSITION or ADD_TO_POSITION, since only those two classifications ever produce a trade. Null for Signal/Market-Intelligence trades and for Bot trades placed before this migration.';
comment on column paper_trades.existing_position_value is
  'GBP value of the existing same-side open position in this instrument immediately before this trade was added (Mission 3). Zero for a brand new position.';
comment on column paper_trades.position_value_after_trade is
  'GBP value of the position in this instrument immediately after this trade (Mission 3) — existing_position_value plus this trade''s own notional.';
comment on column paper_trades.position_decision_reason is
  'One-line explanation of the Position Manager''s classification for this trade (Mission 3).';
