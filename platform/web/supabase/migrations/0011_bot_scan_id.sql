-- Mission 1.1 — Bot Candidate Fallback and Scan Trace
--
-- Adds a single nullable column recording which scan (e.g. "SCAN-000004") produced a Bot-sourced
-- trade. Distinct from source_bot_decision_id (0010_bot_runner.sql): a scan can reject several
-- candidates before one opens a trade, and scan_id is the scan-level id, not a per-candidate one.
-- The full candidate-by-candidate trace itself is NOT persisted here — it's still a simple,
-- local-browser-only feature (see src/lib/state/bot-decision-log-context.tsx) — only the
-- resulting PaperTrade row gets this one extra column, exactly like every other Bot Runner field.

alter table paper_trades
  add column if not exists scan_id text;

comment on column paper_trades.scan_id is
  'The Bot Runner scan (e.g. "SCAN-000004") that produced this trade (Mission 1.1). The full scan trace itself is stored client-side only, not in this table. Null for Signal/Market-Intelligence trades.';
