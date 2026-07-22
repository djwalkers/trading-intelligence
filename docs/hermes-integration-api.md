# Hermes Integration API v1

**v1 is read-only.** Nothing under `/api/hermes/*` can pause, resume, trigger a scan, place an
order, or change configuration or strategy. It exists purely so Hermes Agent (or a human operator)
can inspect the running Trading Intelligence platform.

## Purpose

A small, secure, local-only interface Hermes Agent uses to inspect: overall platform health, the
scheduler/runtime's current state, live demo/paper positions, recent trading decisions, a
portfolio summary, and one compact combined operational snapshot. It reuses the existing runtime,
broker, decision, health, logging, and configuration abstractions this platform already has —
nothing about decision, risk, execution, or scheduler logic is reimplemented or duplicated here.

## Architecture

Two independent OS processes run on the same VPS:

1. **The Next.js app** (`platform/web/`, this API) — request/response, stateless per call.
2. **The standalone trading runtime** (`npm run market:runtime`) — TradingRuntime, the scheduler,
   the eToro demo broker connection, the Telegram bot. See
   [`prototype-v1-vps-handoff.md`](./prototype-v1-vps-handoff.md).

**There is no live, in-process channel between them.** This is the same structural limitation
`get-application-health.ts` already documents for the unrelated VPS worker (`automation: "unknown"`
in `/api/health`) — two separate Node processes, no shared memory, no IPC. This API therefore reads
from two different sources, chosen per field for whichever is genuinely correct:

- **Live broker queries** — for positions and account/cash data, this API constructs its own broker
  connection per request, using the exact same `BrokerFactory`/`PaperBroker` abstraction
  `market-runtime.ts`/`market-decide.ts` already use. This is a real, bounded-timeout network call
  to eToro's demo API on every request that touches broker data (`/positions`, `/portfolio`,
  `/health`, `/summary`) — there is no cache. It uses a **throwaway, in-memory `AuditTrail`**, never
  the shared, disk-persisted `JsonFileAuditTrail` the runtime process writes to — `persist()` there
  is a full-file overwrite, not an atomic append, and two independent processes read-modify-writing
  the same file is a real corruption risk this API must never introduce.
- **The persisted audit log** — for runtime state, recent decisions, and realised P/L, this API
  reads (never writes) the same JSON file the runtime process already produces
  (`.data/hermes-execution/market-runtime-audit-log.json`, via
  `src/lib/hermes-execution/audit-log-path.ts`, a constant shared by both processes). **Both
  processes must run with the same working directory (`platform/web/`)** for this path to resolve
  to the same file — this is the one deployment assumption this design depends on.
- **Static configuration** — runtime mode, broker provider, configured scheduler interval — read
  directly via the existing `getHermesExecutionConfig()`, since the Next.js process and the
  standalone runtime process read the same `.env.local`.

No new server, no REST framework, no database — this is six `route.ts` files under
`src/app/api/hermes/`, reusing existing lib modules.

## Security model

- **Mandatory token authentication on every request** — `Authorization: Bearer <token>`, checked
  against `HERMES_INTEGRATION_TOKEN` with a timing-safe comparison
  (`node:crypto.timingSafeEqual`). There is no unauthenticated mode: if the token isn't configured
  at all, every request is rejected (401) — this is not a "feature disabled, safely open" state.
- **Startup validation** — `instrumentation.ts` calls the same config validation once at server
  boot. A token that's set but blank or shorter than 32 characters crashes server startup
  immediately (confirmed live — see "Manual validation" below), the same fail-closed convention
  every other config module in this codebase uses.
- **The shared guard** — `withHermesGuard()` (`src/lib/hermes-integration/auth.ts`) is the first
  line of every route handler. It is a plain exported function, not Next.js `middleware.ts` —
  deliberately, for two reasons: `crypto.timingSafeEqual` needs the Node.js runtime, which route
  handlers already get by default (no runtime configuration to get right); and a plain function is
  directly unit-testable with this project's existing Vitest setup, with no special middleware test
  harness.
- **Never logs or echoes the token** — it appears only in the incoming `Authorization` header,
  compared byte-for-byte, never included in any log line, error message, or response body. Verified
  by a dedicated automated test and by a live manual check (see below) scanning real responses for
  the configured token and the real eToro credentials.
- **No permissive CORS** — nothing in this API sets `Access-Control-Allow-Origin` or any other CORS
  header; Next.js's own default (no CORS headers on API routes) is left untouched.
- **No client-side exposure** — no UI page or client component references `/api/hermes/*`.

### Local-only enforcement

The intended topology is Hermes Agent and this app on the *same* VPS, calling
`http://127.0.0.1:3000` directly, with no public exposure and no reverse proxy in front.

1. **Network binding to `127.0.0.1` is the authoritative control.** Run `next start -H 127.0.0.1`
   (or configure your process manager/`ecosystem.config.js` to do so) so the port is never reachable
   from outside the VPS at all. A firewall rule blocking external access to the app's port is a
   second, redundant layer of the same control.
2. **Application-level detection was attempted and found unreliable — this is documented, not
   silently worked around.** The original design rejected any request carrying
   `x-forwarded-for`/`x-real-ip`/`forwarded`, on the assumption a genuine direct loopback connection
   would never produce one. **Live testing against this exact server (both `next dev` and
   `next start`, no reverse proxy) disproved that assumption**: Next.js's own request handling sets
   `x-forwarded-for` (and `x-forwarded-host`/`-port`/`-proto`) on *every* request, using the real
   socket peer address (confirmed live: `x-forwarded-for: ::ffff:127.0.0.1` for a genuine loopback
   curl) whenever the client itself didn't set that header. Worse: when a client *does* set
   `x-forwarded-for` itself (confirmed live with `curl -H "X-Forwarded-For: 8.8.8.8"`), Next.js
   passes that client-supplied value straight through unchanged. So the header is present on every
   request including legitimate ones (its presence proves nothing), and its value is fully
   attacker-controlled by anyone who can reach the port at all (a value of `127.0.0.1` proves
   nothing either). **Neither presence nor value can be used as an allow or a deny decision** —
   the original check was removed because it actively rejected 100% of legitimate traffic when
   live-tested, and no alternative version of it would have been more than security theatre.
3. **What actually ships**: `logIfForwardedFromNonLoopback()` in `auth.ts` logs a warning when
   `x-forwarded-for`'s first hop isn't a loopback address — pure observability for an operator
   watching logs, never a gate. It cannot be bypassed because it never blocks anything.
4. Token authentication (above) remains mandatory regardless of any of this, and is the only real
   application-level access control this API has.

**Bottom line**: bind to `127.0.0.1` and firewall the port. That is the actual boundary. Do not
rely on this API to detect or reject a non-local caller by itself.

## Environment configuration

```
# Required for every /api/hermes/* request — there is no unauthenticated mode.
# Generate with: openssl rand -hex 32
HERMES_INTEGRATION_TOKEN=
```

Add to `platform/web/.env.local` (never commit a real value — see `.env.example` for the
placeholder and full documentation). Minimum 32 characters; shorter (but non-empty) values fail
server startup with a clear `ConfigError`, confirmed live (see "Manual validation"). Unset entirely
means every request is rejected with 401.

## Endpoint reference

Every endpoint requires `Authorization: Bearer <HERMES_INTEGRATION_TOKEN>` and returns the same
envelope shape.

**Success:**
```json
{ "ok": true, "data": { }, "meta": { "timestamp": "2026-01-01T00:00:00.000Z" } }
```

**Failure:**
```json
{ "ok": false, "error": { "code": "STABLE_MACHINE_CODE", "message": "Safe message" }, "meta": { "timestamp": "..." } }
```

| Endpoint | Method | Notes |
|---|---|---|
| `/api/hermes/health` | GET | Overall health — application/broker/marketData/runtime components. |
| `/api/hermes/runtime` | GET | Scheduler state, counts, configured interval, runtime mode. |
| `/api/hermes/positions` | GET | Live demo/paper positions, queried from the broker directly. |
| `/api/hermes/decisions` | GET | Recent trading decisions. Query params: `limit` (default 20, max 100), `symbol`, `outcome` (`BUY`/`SELL`/`HOLD`), `since` (ISO date/time). |
| `/api/hermes/portfolio` | GET | Cash, invested value, realised P/L, open position count. |
| `/api/hermes/summary` | GET | A compact combination of the above, degrading independently per subsystem. |

Error codes used: `UNAUTHORIZED` (401), `INVALID_QUERY_PARAMETER` (400), `BROKER_UNAVAILABLE` (503),
`CONFIGURATION_ERROR` (500), `UNKNOWN_ERROR` (500, the last-resort safety net — never a raw stack
trace).

### `GET /api/hermes/health`

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "status": "healthy",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "runtimeMode": "demo",
    "brokerProvider": "etoro-demo",
    "marketDataProvider": "live",
    "components": { "application": "healthy", "broker": "healthy", "marketData": "healthy", "runtime": "RUNNING" },
    "warnings": []
  },
  "meta": { "timestamp": "2026-01-01T00:00:00.000Z" }
}
```

`broker` is a genuine, bounded-timeout connection attempt made this request — never assumed
healthy. `runtime` is inferred from the persisted audit log only (`RUNNING`/`PAUSED`/`STOPPED`/
`unknown`) — `unknown` whenever no lifecycle event has been observed, never guessed.

### `GET /api/hermes/runtime`

```json
{
  "ok": true,
  "data": {
    "state": "RUNNING",
    "startedAt": "2026-01-01T00:00:00.000Z",
    "lastRunAt": "2026-01-01T00:05:00.000Z",
    "nextRunAt": null,
    "successfulRunCount": 5,
    "failedRunCount": 0,
    "skippedOverlapCount": 0,
    "lastError": null,
    "configuredIntervalMs": 60000,
    "runtimeMode": "demo",
    "observedFromAuditLog": true
  },
  "meta": { "timestamp": "..." }
}
```

`nextRunAt` is **always `null`** — there is no live channel to the scheduler process to know this
with any confidence, and this API never invents a value for it. `configuredIntervalMs`/
`runtimeMode` are read directly from configuration (always available); every other field is
observed from the audit log and scoped to the most recent runtime start.

### `GET /api/hermes/positions`

```json
{
  "ok": true,
  "data": {
    "positions": [
      { "instrument": "1001", "side": "BUY", "quantity": 50, "entryPrice": 100.2, "currentPrice": null, "unrealisedPnl": null, "openedAt": "2026-01-01T00:00:00.000Z", "provider": "etoro-demo", "accountMode": "demo" }
    ],
    "count": 1,
    "provider": "etoro-demo",
    "accountMode": "demo",
    "positionsAreLiveGroundTruth": true
  },
  "meta": { "timestamp": "..." }
}
```

`instrument` is eToro's numeric `instrumentID` — eToro's raw position response carries no
human-readable symbol, and this API does not fabricate one (resolving it would mean fetching
eToro's entire ~16,000-instrument universe per request). `currentPrice`/`unrealisedPnl` are always
`null` for the same "never fabricate" reason (see Known Limitations). Returns `503
BROKER_UNAVAILABLE` if the broker connection itself fails — never a fabricated empty list.

### `GET /api/hermes/decisions`

```
GET /api/hermes/decisions?limit=10&symbol=BTC&outcome=BUY&since=2026-01-01T00:00:00Z
```

```json
{
  "ok": true,
  "data": {
    "decisions": [
      {
        "timestamp": "2026-01-01T00:05:00.000Z",
        "symbol": "BTC",
        "outcome": "BUY",
        "confidence": 0.7,
        "reasons": ["EMA20 above EMA50"],
        "strategy": "STRAT-0001",
        "marketSnapshot": { "trend": "Bullish", "rsi14": 61.2 },
        "executionResult": { "executed": true, "status": "OPENED" }
      }
    ],
    "count": 1,
    "filters": { "limit": 10, "symbol": "BTC", "outcome": "BUY", "since": "2026-01-01T00:00:00.000Z" },
    "observedFromAuditLog": true
  },
  "meta": { "timestamp": "..." }
}
```

Sourced entirely from existing `MARKET_DECISION_RECEIVED` audit events — nothing here re-runs or
re-derives a decision. `executionResult.status` is one of `HOLD`/`RISK_REJECTED`/`OPENED`/
`CLOSED`/`EXECUTION_FAILED`/`CLOSE_FAILED`/`SKIPPED`/`unknown`. An invalid `limit` (non-integer,
≤0, or >100), `since`, or `outcome` returns `400 INVALID_QUERY_PARAMETER` with a specific message.

### `GET /api/hermes/portfolio`

```json
{
  "ok": true,
  "data": {
    "accountMode": "demo",
    "provider": "etoro-demo",
    "cash": 103259.15,
    "investedValue": 0,
    "realisedPnl": null,
    "realisedPnlScope": "since last runtime start (audit log is not durable across restarts)",
    "unrealisedPnl": null,
    "equity": null,
    "openPositionCount": 0,
    "timestamp": "...",
    "positionsAreLiveGroundTruth": true
  },
  "meta": { "timestamp": "..." }
}
```

`cash` is live (a real, bounded-timeout eToro API call). `realisedPnl` sums `TRADE_CLOSED` audit
events since the runtime's last start — `null`, never `0`, when there are none. `unrealisedPnl`/
`equity` are always `null` — see Known Limitations.

### `GET /api/hermes/summary`

Combines the above; never crashes if one subsystem is unavailable (see Reliability below).

```json
{
  "ok": true,
  "data": {
    "timestamp": "...",
    "health": { "status": "healthy", "runtimeMode": "demo", "brokerProvider": "etoro-demo" },
    "runtime": { "state": "RUNNING", "lastRunAt": "...", "successfulRunCount": 5, "failedRunCount": 0 },
    "portfolio": { "accountMode": "demo", "provider": "etoro-demo", "cash": 103259.15, "investedValue": 0, "realisedPnl": null, "openPositionCount": 0 },
    "openPositionCount": 0,
    "latestDecision": null,
    "recentFailure": null,
    "warnings": []
  },
  "meta": { "timestamp": "..." }
}
```

## Curl examples

```bash
curl \
  -H "Authorization: Bearer $HERMES_INTEGRATION_TOKEN" \
  http://127.0.0.1:3000/api/hermes/summary
```

```bash
curl \
  -H "Authorization: Bearer $HERMES_INTEGRATION_TOKEN" \
  "http://127.0.0.1:3000/api/hermes/decisions?limit=10&outcome=BUY"
```

Never put a real token directly in a command you might paste elsewhere — export it to a shell
variable first (`export HERMES_INTEGRATION_TOKEN=...`) and reference `$HERMES_INTEGRATION_TOKEN`.

## Localhost-only deployment guidance

- Start the app bound to loopback only: `next start -H 127.0.0.1` (adjust your process
  manager/`ecosystem.config.js` `args` accordingly).
- Firewall the app's port from external access as a second, redundant layer.
- Hermes Agent, running on the same VPS, calls `http://127.0.0.1:3000/api/hermes/...` directly — no
  reverse proxy is needed or assumed by this design (see "Local-only enforcement" above for what
  changes if one is ever added).

## How Hermes should consume this API

Poll at a reasonable interval (e.g. `/summary` every 30–60 seconds) — every request that touches
broker data makes a real, bounded-timeout network call to eToro; there is no caching. Prefer
`/summary` for a routine check-in; use `/decisions`, `/positions`, or `/portfolio` directly when
more detail on one area is needed. Always check the top-level `ok` field first, then `error.code`
on failure — codes are stable and safe to branch on; `error.message` is safe to display but not
guaranteed stable wording.

## Known limitations

- **`nextRunAt` is always `null`** — no live channel to the scheduler process.
- **`currentPrice`/`unrealisedPnl`/`equity` are always `null`** — computing them would need a live
  rate lookup per open position, which the existing broker abstraction doesn't cheaply expose for
  eToro (would require an additional API call per position, per request); never fabricated.
- **`realisedPnl` is scoped to "since the runtime's last start"**, not all-time — the trading
  runtime's own audit log is truncated fresh on every process restart
  (`JsonFileAuditTrail.createFresh()`), a pre-existing limitation of the runtime itself, not
  something this API introduces.
- **Positions for eToro come from a genuine live broker call**, not a cache — every request that
  touches position/portfolio data incurs real network latency and eToro API usage.
- **Position `instrument` is eToro's numeric ID**, not a human-readable symbol — see the
  `/positions` reference above.
- **The audit log path assumption**: both the Next.js process and the standalone `market:runtime`
  process must share the same working directory for `/runtime`, `/decisions`, and the `realisedPnl`
  field to reflect real data — otherwise they degrade honestly to `unknown`/`null`/empty, never a
  crash, but also never real data.
- **Local-only enforcement is binding + firewall, not application code** — see the dedicated
  section above; this was empirically tested, not assumed.

## v1 is read-only

No endpoint under `/api/hermes/*` can pause, resume, trigger a scan, place or close an order, or
change configuration, risk rules, or strategy. Every route in this milestone is a `GET`. A future
mutating v2 (if ever built) would need its own explicit authorization/audit design — nothing here
should be assumed to extend to it.
