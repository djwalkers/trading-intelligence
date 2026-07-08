-- Mission 1 — Bot Runner
--
-- Widens paper_trades.source to allow 'Bot' (autonomous, manually-triggered trades from the Bot
-- Runner), and adds two nullable columns recording bot-specific metadata. The bot decision log
-- itself is NOT persisted here — it's a simple, local-browser-only feature (see
-- src/lib/state/bot-decision-log-context.tsx and
-- docs/product/MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md) — only the resulting PaperTrade rows
-- flow through this schema, exactly like Signal- and Market-Intelligence-sourced trades.

alter table paper_trades drop constraint if exists paper_trades_source_check;
alter table paper_trades add constraint paper_trades_source_check
  check (source in ('Signal', 'Market Intelligence', 'Bot'));

alter table paper_trades
  add column if not exists source_bot_decision_id text,
  add column if not exists risk_checks_summary text;

comment on column paper_trades.source_bot_decision_id is
  'Links a Bot-sourced trade back to its BotDecision log entry (Mission 1). The decision log itself is stored client-side only, not in this table.';
comment on column paper_trades.risk_checks_summary is
  'One-line summary of the Bot Runner risk checks that passed for this trade (Mission 1). Null for Signal/Market-Intelligence trades.';
