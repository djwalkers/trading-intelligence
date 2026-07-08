-- Build 1.2.0 — entry price provenance on paper_trades
--
-- Records where a trade's entry price came from, alongside the existing entry_price column
-- itself. All three are nullable and purely informational — never required for P/L math (that's
-- still just entry_price vs. current/exit price) — so trades placed before this migration, or by
-- anyone who skips it, are unaffected; they simply have no provenance recorded.

alter table paper_trades
  add column if not exists entry_price_source text
    check (entry_price_source is null or entry_price_source in ('Mock', 'External')),
  add column if not exists entry_price_provider text,
  add column if not exists entry_price_timestamp timestamptz;

comment on column paper_trades.entry_price_source is
  'Mock or External — which kind of MarketDataProvider supplied entry_price (Build 1.2.0). Null on trades placed before this migration.';
comment on column paper_trades.entry_price_provider is
  'Display label of the provider that supplied entry_price, e.g. "Mock" or "Finnhub" (Build 1.2.0).';
comment on column paper_trades.entry_price_timestamp is
  'When the entry_price quote was fetched (Build 1.2.0) — distinct from opened_at, which is when the trade itself was placed.';
