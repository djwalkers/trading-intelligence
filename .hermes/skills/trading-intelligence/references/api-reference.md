# API Reference

Full field-by-field reference for the Trading Intelligence Integration API v1. The authoritative
source is `docs/hermes-integration-api.md` in the platform repository — this file summarizes it
for quick lookup while answering a question; if anything here seems to conflict with a live
response, trust the live response and the platform doc, not this file.

Every request needs `Authorization: Bearer $HERMES_INTEGRATION_TOKEN`. Every response is the same
envelope — see SKILL.md's "How to call the API" section. Error codes: `UNAUTHORIZED` (401),
`INVALID_QUERY_PARAMETER` (400), `BROKER_UNAVAILABLE` (503), `CONFIGURATION_ERROR` (500),
`UNKNOWN_ERROR` (500).

## `GET /api/hermes/summary`

Always call this first. Combines the other endpoints; degrades one subsystem at a time rather than
failing outright.

| Field | Meaning |
|---|---|
| `health.status` | `healthy` / `degraded` / `unavailable` / `unknown` — overall platform health. |
| `runtime.state` | `RUNNING` / `PAUSED` / `STOPPED` / `unknown`. |
| `runtime.lastRunAt`, `successfulRunCount`, `failedRunCount` | Scoped to the current run (since the runtime's most recent start). |
| `portfolio` | Same shape as `/portfolio`'s own `data`, or `null` if the broker/portfolio check failed this request. |
| `openPositionCount` | `null` if the broker check failed — not `0`. |
| `latestDecision` | The single most recent decision (same shape as one entry in `/decisions`), or `null` if none observed. |
| `recentFailure` | The most recent failure-worthy event (cycle failure, risk rejection, execution/close failure, broker failure) anywhere in the audit log, or `null`. |
| `warnings` | Array of short strings — read these before concluding "everything is fine." An empty array means no known problem; a non-empty array explains exactly what's degraded and why. |

## `GET /api/hermes/runtime`

| Field | Meaning |
|---|---|
| `state` | `RUNNING` / `PAUSED` / `STOPPED` / `unknown`. Derived from the persisted audit log's most recent lifecycle event — never guessed. `unknown` means no lifecycle event has been observed (e.g. right after a restart, before the runtime's own audit log exists again). |
| `startedAt` | Timestamp of the most recent start, or `null`. |
| `lastRunAt` | Timestamp of the most recent completed or failed cycle, or `null`. |
| `nextRunAt` | **Always `null`.** There is no live channel to the scheduler process — never invent a predicted next-run time, even if `configuredIntervalMs` and `lastRunAt` make one look easy to compute. |
| `successfulRunCount` / `failedRunCount` / `skippedOverlapCount` | Scoped to the current run only — these reset to zero on every runtime restart, by design (mirrors the runtime's own in-memory counters). |
| `lastError` | `{ message, occurredAt }` for the most recent failed cycle in the current run, or `null`. |
| `configuredIntervalMs` | The scheduler's configured interval — always available (read from configuration directly, not observed). |
| `runtimeMode` | e.g. `"demo"` — always available, from configuration. |
| `observedFromAuditLog` | `false` means the audit log itself couldn't be read — every other observed field (state/counts/lastRunAt/lastError) should be treated as unknown, not as "zero"/"stopped," when this is `false`. |

## `GET /api/hermes/positions`

| Field | Meaning |
|---|---|
| `positions[].instrument` | eToro's **numeric instrument ID**, not a ticker (e.g. `"1001"`, not `"BTC"`). eToro's raw position data carries no human-readable symbol; do not guess one. If you need to map an ID to something recognizable, say you don't have that mapping rather than guessing which instrument it probably is. |
| `positions[].side` | `BUY` / `SELL` / `unknown`. |
| `positions[].quantity` | CFD notional amount for eToro, not a share count. |
| `positions[].entryPrice` | The price the position was opened at, or `null` if not available. |
| `positions[].currentPrice`, `positions[].unrealisedPnl` | **Always `null`.** Never available in v1 — say "not available" if asked, don't compute an estimate yourself from `entryPrice` and anything else. |
| `positions[].openedAt` | ISO timestamp, or `null`. |
| `count` | Number of open positions — `0` is a real, meaningful answer ("no open positions"), distinct from a failed call (which returns an error envelope instead, not an empty list). |
| `positionsAreLiveGroundTruth` | `true` for the platform's current fixed broker (eToro demo) — this reflects the real account, not a local cache. |

A failed broker connection returns the standard error envelope (`503 BROKER_UNAVAILABLE`), never an
empty position list standing in for "couldn't check."

## `GET /api/hermes/decisions`

Query params (all optional): `limit` (integer, default 20, max 100 — values outside this range are
rejected with `400 INVALID_QUERY_PARAMETER`, not clamped), `symbol`, `outcome` (`BUY`/`SELL`/`HOLD`,
case-insensitive), `since` (ISO 8601 date/time; only decisions at or after it are returned).
Results are always newest first.

| Field | Meaning |
|---|---|
| `decisions[].timestamp` | When the decision was made. |
| `decisions[].symbol` | The instrument the decision concerned. |
| `decisions[].outcome` | `BUY` / `SELL` / `HOLD` — the decision engine's own action, not a prediction. |
| `decisions[].confidence` | A number the decision engine attached, or `null`. |
| `decisions[].reasons` | The decision engine's own stated reasons — quote or summarize these directly rather than paraphrasing into something that changes their meaning. |
| `decisions[].strategy` | The strategy ID that produced this decision, or `null`. |
| `decisions[].marketSnapshot` | Whatever indicator context (trend, RSI, etc.) was recorded alongside the decision — varies, don't assume a fixed set of keys. |
| `decisions[].executionResult.status` | One of `HOLD`, `RISK_REJECTED`, `OPENED`, `CLOSED`, `EXECUTION_FAILED`, `CLOSE_FAILED`, `SKIPPED`, `unknown` (unknown = no matching downstream event found — say so, don't guess which of the others it probably was). |
| `decisions[].executionResult.realisedPnl` | Only present when `status` is `CLOSED`. |
| `filters` | Echoes back exactly what was applied — use this to confirm you filtered the way you intended before reporting a count. |
| `observedFromAuditLog` | `false` means the underlying audit log couldn't be read — an empty `decisions` array in that case means "couldn't check," not "no decisions happened." Always check this before reporting "no decisions" as a real finding. |

## `GET /api/hermes/portfolio`

| Field | Meaning |
|---|---|
| `cash` | Live — a real broker call made this request. |
| `investedValue` | Sum of current open positions' notional/quantity. |
| `realisedPnl` | Sum of closed trades **since the runtime's last restart**, or `null` if there have been none. Never all-time — the runtime's own audit log resets on every restart (a pre-existing platform limitation, not something this API adds). If asked for "total" or "all-time" P/L, say plainly that only the since-last-restart figure is available. |
| `realisedPnlScope` | Literally states the scope in words — read it back if there's any doubt. |
| `unrealisedPnl`, `equity` | **Always `null`.** Not available in v1 — computing them would need a live rate per open position, which isn't cheaply available. Say "not available," never derive an estimate. |
| `openPositionCount` | Same live count as `/positions`'s `count`. |
| `positionsAreLiveGroundTruth` | Same meaning as in `/positions`. |

## `GET /api/hermes/health`

Only call directly for a deep health inspection — `/summary`'s own `health` object is enough for a
routine check.

| Field | Meaning |
|---|---|
| `status` | Overall: `healthy` / `degraded` / `unavailable` / `unknown`. |
| `components.application` | Whether the platform's own configuration loaded successfully. |
| `components.broker` | A genuine connection attempt made this request — `unavailable` means it just failed, not that it's untested. |
| `components.marketData` | `healthy` for both `"mock"` and `"live"` providers when reachable — check `runtimeMode`/`marketDataProvider` alongside this if the distinction matters to the question asked. |
| `components.runtime` | `RUNNING` / `PAUSED` / `STOPPED` / `unknown` — same semantics as `/runtime`'s own `state`. |
| `warnings` | Explains every non-`healthy` component in plain language — read these before summarizing status in your own words. |
