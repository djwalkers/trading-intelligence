-- Build 0.7.0 — trade_events
--
-- Append-only audit log of open/close events per paper trade. Not required by the current UI
-- (which reads opened_at/closed_at directly off paper_trades), but cheap to add now and useful
-- the moment partial closes, re-opens, or an activity feed are wanted — better to design it in
-- from the start than retrofit it onto an existing table later.

create table if not exists trade_events (
  id uuid primary key default gen_random_uuid(),
  paper_trade_id uuid not null references paper_trades (id) on delete cascade,

  event_type text not null check (event_type in ('opened', 'closed')),
  event_at timestamptz not null default now(),
  price numeric not null, -- entry price for 'opened', exit price for 'closed'
  metadata jsonb
);

comment on table trade_events is
  'Prototype-only (Build 0.7.0). Append-only audit log of open/close events. Not yet read by the app.';
