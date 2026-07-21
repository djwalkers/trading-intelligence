# Prototype V1 — VPS Handoff (eToro Demo + Telegram)

What this repo (the Trading Platform, `platform/web/`) needs to run continuously on a VPS, and the
boundary the separately-installed Hermes Agent (github.com/NousResearch/hermes-agent) uses to
operate it. Hermes Agent itself, its AI provider, and its own Telegram gateway are **not** part of
this repo and are **not** covered here — they are configured during Hermes Agent's own official
installation, on the VPS, independently of everything below.

## Three separate processes, three separate installs

1. **This repo's trading runtime** — `npm run market:runtime`. A single long-running Node process:
   TradingRuntime on a scheduler, eToro demo broker, live market data, the minimum Telegram bot
   (alerts + `/status /positions /trades /pnl /pause /resume /run /help`). This is what actually
   opens/closes trades.
2. **This repo's one-shot decision CLI** — `npm run market:decide`. Runs exactly one decision cycle
   against the eToro demo broker and exits. Useful as an on-demand boundary (see below) distinct
   from the continuous scheduler in (1); always hard-coded to eToro regardless of `BROKER_PROVIDER`
   (a deliberate, pre-existing safety choice — see `src/hermes-execution/market-decide.ts`'s own
   top-of-file comment).
3. **Hermes Agent** — installed on the VPS via its own official installer, entirely separately from
   this repo's `npm install`/`npm run build`. Do not install or embed it inside this repo.

## Required environment variables for (1) and (2)

Set these in the VPS's own `.env.local` (or process-manager env config) next to this repo's
checkout — never commit real values. Full documentation/defaults for every one of these lives in
`.env.example` at the repo root; this is the minimum subset Prototype V1 actually needs.

```
# Strategy source (a populated or empty strategy-registry directory; DEMO_EXECUTION_MODE=true
# loads the built-in demo fixture strategy if the registry itself is empty/not yet populated)
HERMES_STRATEGY_REGISTRY_PATH=/absolute/path/to/strategy-registry
DEMO_EXECUTION_MODE=true

# Broker / mode — Prototype V1 is fixed to eToro demo. Trading212 is rejected at startup
# (checkPrototypeV1BrokerSupport) regardless of what this is set to.
BROKER_PROVIDER=etoro-demo
HERMES_RUNTIME_MODE=demo
ETORO_ENV=demo
ETORO_API_KEY=...
ETORO_USER_KEY=...
ETORO_DEMO_TEST_INSTRUMENT=BTC
ETORO_DEMO_TEST_AMOUNT=<CFD notional amount in USD — must be set explicitly, no default>

# Live market data (reads real bid/ask through the connected eToro broker itself)
HERMES_MARKET_DATA_PROVIDER=live

# Scheduler — continuous runtime only (process (1) above); market:decide ignores these
HERMES_SCHEDULER_ENABLED=true
HERMES_SCHEDULER_INTERVAL_MS=<>= 5000; pick something sane for a live account, not the 5000ms floor>
HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS=30000        # reliability fix default; raise/lower deliberately
ETORO_HTTP_TIMEOUT_MS=10000                     # reliability fix default

# Telegram — optional, but all three below are required together once enabled (fails closed
# otherwise, before the runtime starts)
HERMES_TELEGRAM_ENABLED=true
HERMES_TELEGRAM_BOT_TOKEN=<from @BotFather — never commit>
HERMES_TELEGRAM_ALLOWED_CHAT_ID=<your numeric chat id — from @userinfobot>
```

## Exact commands

```bash
# One-time setup on the VPS
git clone <this repo> && cd platform/web
npm install
npm run build

# Start the continuous runtime (process 1) — long-running, restart-on-crash is the operator's
# responsibility (systemd/pm2/tmux — no installer or unit file is provided by this milestone)
npm run market:runtime

# On-demand single decision cycle (process 2) — exits after one cycle
npm run market:decide
```

`npm run market:runtime` logs a redacted startup summary (no credentials, only presence booleans
including `telegramConfigured`) before starting, and stops gracefully on `SIGINT`/`SIGTERM`
(bounded by `HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS`) — that includes stopping the Telegram bot's
polling loop, not just the trading scheduler.

## The boundary Hermes Agent uses

Hermes Agent should treat this repo as an external system it operates through exactly two
interfaces, neither of which required any new code this milestone:

- **The existing CLI commands** — `npm run market:runtime` (start/stop the continuous service,
  e.g. via systemd) and `npm run market:decide` (trigger one decision on demand).
- **The Telegram bot itself** — the same `/status /positions /trades /pnl /pause /resume /run
  /help` commands a human operator would use. Hermes Agent's own Telegram gateway is a separate
  bot/config from `HERMES_TELEGRAM_BOT_TOKEN` above; if Hermes Agent is ever meant to issue these
  commands itself (not just a human watching the same chat), it would do so as an authorized
  sender to this bot's configured chat id — not implemented or required by this milestone, noted
  here only as the shortest available path if it's ever needed.

No REST API, MCP server, or webhook was built for this — deliberately out of scope per the
mission's "keep this simple" constraint.

## Known limitations to carry into VPS operation

- **Trade history does not survive a restart.** `TradeLifecycleStore` is in-memory only
  (`InMemoryTradeLifecycleStore`), and the audit trail file is truncated fresh
  (`JsonFileAuditTrail.createFresh`) on every process start. A crash or redeploy loses `/positions`,
  `/trades`, `/pnl`, and the audit log for anything before the restart — any *open* eToro position
  itself is unaffected (it still exists on eToro's side), but this pipeline's own record of it is
  gone until manually reconciled. No persistence layer for this was in scope this milestone.
- **Trading212 is unsupported and fails closed** — confirmed via live testing that its order-fill
  polling can return HTTP 404 after a real position is opened, leaving it unmanaged. Selecting
  `BROKER_PROVIDER=trading212-demo` is rejected at startup validation, before any broker call is
  made.
- **No trade-review/learning-history generation** — this milestone's Telegram commands report
  already-computed figures (win rate, realised P/L) from existing lifecycle records; no new
  analysis, backtesting, or historical-performance feature was added.
