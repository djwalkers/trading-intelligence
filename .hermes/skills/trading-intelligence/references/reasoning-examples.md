# Reasoning Examples

Worked, multi-step reasoning for questions that can't be answered from a single field. The pattern
throughout: **inspect broadly first, narrow only as needed, never conclude before checking.**

---

## Example 1: "Why didn't BTC trade today?"

**Step 1 — inspect `/summary`.**

```json
{
  "health": { "status": "healthy", "runtimeMode": "demo", "brokerProvider": "etoro-demo" },
  "runtime": { "state": "RUNNING", "lastRunAt": "2026-01-01T16:00:00.000Z", "successfulRunCount": 96, "failedRunCount": 0 },
  "latestDecision": { "symbol": "BTC", "outcome": "HOLD", "timestamp": "2026-01-01T16:00:00.000Z", "executionResult": { "executed": false, "status": "HOLD" } },
  "recentFailure": null,
  "warnings": []
}
```

Runtime is running, no failures, no warnings. The most recent decision was already a HOLD on BTC —
a good sign this is a "the strategy just never signaled," not "something broke."

**Step 2 — inspect `/decisions?symbol=BTC&since=<start of day>`** to see the whole day, not just
the latest tick.

```json
{
  "decisions": [
    { "timestamp": "...T16:00:00Z", "outcome": "HOLD", "reasons": ["Trend is Sideways, not Bullish", "No entry signal under strategy STRAT-0001"] },
    { "timestamp": "...T15:00:00Z", "outcome": "HOLD", "reasons": ["Trend is Sideways, not Bullish", "No entry signal under strategy STRAT-0001"] },
    { "timestamp": "...T14:00:00Z", "outcome": "HOLD", "reasons": ["RSI 52 — no oversold/overbought signal"] }
  ]
}
```

Every decision today was HOLD, for stated reasons tied to the strategy's own entry conditions —
not a risk rejection, not an execution failure.

**Step 3 — explain**, citing both steps:

> BTC didn't trade today because the strategy never signaled an entry — every decision cycle
>(3 checked, going back to 14:00 UTC) came back HOLD, mostly because the trend was reading
> Sideways rather than Bullish. The runtime itself ran normally all day (96 successful cycles, 0
> failures) — this isn't a broker or runtime problem, the strategy simply didn't see a setup it
> wanted.

**What NOT to do:** answer from `/summary` alone ("last decision was HOLD, so nothing traded") —
that's true but doesn't show the *pattern*, and doesn't rule out an earlier problem that day. Also
wrong: guessing a reason not present in `reasons` (e.g. "probably low volume" when the actual
recorded reason was about trend/RSI).

---

## Example 2: "Why did the runtime stop?"

**Step 1 — `/runtime`.**

```json
{ "state": "STOPPED", "lastRunAt": "2026-01-01T14:02:00.000Z", "lastError": null, "failedRunCount": 0 }
```

`lastError` is `null` and `failedRunCount` is `0` — nothing in the audit trail indicates a crash.

**Step 2 — `/summary`**, to check `recentFailure` (which looks across a wider event set than
`/runtime`'s own scoped `lastError`).

```json
{ "recentFailure": null, "warnings": [] }
```

Still nothing.

**Step 3 — explain:**

> Runtime is STOPPED, last run completed cleanly at 14:02 UTC. No error recorded anywhere in the
> audit log (`lastError` is null, no recent failure, no warnings) — this looks like a deliberate or
> external stop, not a crash. I can't see *who* or *what* stopped it (no live process-lifecycle
> data beyond the audit log), just that it wasn't a recorded failure.

Note the honest boundary at the end — the API genuinely can't distinguish "an operator ran
`pause`/stopped the process" from "the VPS rebooted." Say what you can conclude and stop there.

---

## Example 3: "How's the portfolio doing overall?"

**Step 1 — `/portfolio`.**

```json
{
  "cash": 98750.00,
  "investedValue": 1200,
  "realisedPnl": -125.50,
  "realisedPnlScope": "since last runtime start (audit log is not durable across restarts)",
  "unrealisedPnl": null,
  "equity": null,
  "openPositionCount": 1
}
```

**Step 2 — decide if `/decisions` adds anything.** The user asked a general performance question,
not "why" — a single `/portfolio` call is enough here; don't over-fetch.

**Step 3 — explain, including the real limitation:**

> Cash: $98,750. One open position, $1,200 invested. Realised P/L is -$125.50, but that's scoped to
> since the runtime's last restart, not all-time — there's no lifetime figure available through
> this API. Unrealised P/L and equity aren't available in this version, so I can't give you a
> single all-in number — only cash, invested value, and the scoped realised figure above.

**What NOT to do:** compute a pseudo-equity as `cash + investedValue` and present it as "equity" —
that's not what the platform's own `equity` field would mean (it's `null` for a reason: it's meant
to net unrealised P/L in too, which isn't available) and presenting an invented approximation as
the real figure is exactly the fabrication this skill exists to prevent.
