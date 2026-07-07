-- Build 0.7.0 — sample paper trades
--
-- For exercising the schema directly in Supabase Studio or psql after running the migrations.
-- The app does NOT read this data — as of Build 0.7.0 it still uses localStorage exclusively
-- (see docs/product/BUILD-0.7.0.md). This is purely to let you verify the tables work before
-- any app code ever talks to them.
--
-- Covers: an open Signal trade, an open Market Intelligence trade (with its trade_intelligence
-- row), a closed trade with realised P/L, and trade_events for every open/close above.

insert into paper_trades (
  client_trade_id, instrument_symbol, instrument_name, side, quantity, entry_price,
  status, source, strategy_name, reason, signal_confidence,
  source_signal_id, opened_at
) values (
  'seed-trade-nvda-open', 'NVDA', 'NVIDIA Corporation', 'BUY', 2, 134.87,
  'Open', 'Signal', 'Momentum Breakout',
  'Price broke above 20-day high on 1.6x average volume.', 78,
  'sig-001', now() - interval '2 days'
);

insert into paper_trades (
  client_trade_id, instrument_symbol, instrument_name, side, quantity, entry_price,
  status, source, strategy_name, reason, signal_confidence,
  source_opportunity_id, opened_at
) values (
  'seed-trade-msft-open', 'MSFT', 'Microsoft Corporation', 'BUY', 1, 441.06,
  'Open', 'Market Intelligence', 'Market Intelligence Engine',
  'Microsoft is trading in a well-established uptrend, holding consistently above both its 20-day and 50-day moving averages.',
  84, 'opp-msft', now() - interval '1 day'
);

insert into trade_intelligence (paper_trade_id, recommendation, evidence, evidence_factors, invalidation_factors)
select
  id,
  'Strong Buy',
  '[
    {"label": "Trend", "score": 5},
    {"label": "Momentum", "score": 4},
    {"label": "Volume", "score": 5},
    {"label": "Volatility", "score": 3},
    {"label": "Market Direction", "score": 4}
  ]'::jsonb,
  array[
    '20-day moving average is above the 50-day moving average',
    'Momentum indicator has turned positive over the past 5 sessions',
    'Volume on up days is running above the 20-day average'
  ],
  array[
    'Price closes below the 50-day moving average',
    'Momentum indicator turns negative'
  ]
from paper_trades where client_trade_id = 'seed-trade-msft-open';

insert into paper_trades (
  client_trade_id, instrument_symbol, instrument_name, side, quantity, entry_price,
  status, source, strategy_name, reason, signal_confidence,
  source_signal_id, exit_price, closed_at, realised_pnl, realised_pnl_percent, opened_at
) values (
  'seed-trade-aapl-closed', 'AAPL', 'Apple Inc.', 'BUY', 1, 213.42,
  'Closed', 'Signal', 'Mean Reversion',
  'Price extended above short-term average; reversion risk elevated.', 52,
  'sig-005', 214.70, now() - interval '1 day', 1.28, 0.60, now() - interval '5 days'
);

insert into trade_events (paper_trade_id, event_type, event_at, price)
select id, 'opened', opened_at, entry_price from paper_trades where client_trade_id = 'seed-trade-nvda-open';

insert into trade_events (paper_trade_id, event_type, event_at, price)
select id, 'opened', opened_at, entry_price from paper_trades where client_trade_id = 'seed-trade-msft-open';

insert into trade_events (paper_trade_id, event_type, event_at, price)
select id, 'opened', opened_at, entry_price from paper_trades where client_trade_id = 'seed-trade-aapl-closed';

insert into trade_events (paper_trade_id, event_type, event_at, price)
select id, 'closed', closed_at, exit_price from paper_trades where client_trade_id = 'seed-trade-aapl-closed';
