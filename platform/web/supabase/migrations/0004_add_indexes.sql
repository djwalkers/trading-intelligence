-- Build 0.7.0 — indexes
--
-- paper_trades: the five lookups the app's own queries will need most — recency ordering,
-- filtering by status/source (Trade Journal's filters), and filtering by instrument/side.
create index if not exists paper_trades_created_at_idx on paper_trades (created_at);
create index if not exists paper_trades_status_idx on paper_trades (status);
create index if not exists paper_trades_source_idx on paper_trades (source);
create index if not exists paper_trades_instrument_symbol_idx on paper_trades (instrument_symbol);
create index if not exists paper_trades_side_idx on paper_trades (side);

-- Foreign key columns on the extension tables — not explicitly requested, but any join back to
-- paper_trades depends on these, so they're included alongside the required indexes above.
create index if not exists trade_intelligence_paper_trade_id_idx
  on trade_intelligence (paper_trade_id);
create index if not exists trade_events_paper_trade_id_idx
  on trade_events (paper_trade_id);
create index if not exists trade_events_event_at_idx on trade_events (event_at);
