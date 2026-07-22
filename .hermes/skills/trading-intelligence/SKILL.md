---
name: trading-intelligence
description: Inspect and reason about the Trading Intelligence autonomous trading platform through its local, read-only Integration API — runtime status, open positions, portfolio P/L, recent trading decisions, and platform health. Use when asked whether trading is running, what positions are open, how the portfolio is performing, why a trade did or didn't happen, or for a general status/health check of Trading Intelligence or its eToro demo runtime.
license: Proprietary — internal to the Trading Intelligence repository, not for external distribution.
compatibility: Requires the Trading Intelligence Integration API (a Next.js app) reachable locally at http://127.0.0.1:3000/api/hermes/*, and HERMES_INTEGRATION_TOKEN available in this skill's environment, matching the value the API itself is configured with. Requires an HTTP client (curl or equivalent).
metadata:
  author: trading-intelligence-platform
  version: "1.0.0"
  tags: "trading, portfolio, positions, decisions, runtime, health, read-only"
---

# Trading Intelligence

## What this is

Trading Intelligence is an autonomous trading platform already running on this host (or one
reachable at the configured base URL). It provides live market data, a broker abstraction
(currently eToro demo), a runtime scheduler, portfolio management, paper/demo trade execution,
health monitoring, and a persisted history of trading decisions. This skill teaches you how to
inspect that platform through its **Integration API v1** — nothing more.

## What this is NOT

- **Not a place to invent numbers.** Every figure you report — cash, P/L, positions, runtime
  state, decisions — must come from an actual API response this session. Never estimate, recall
  from a prior conversation, or fill in a plausible-looking number.
- **Not a control surface.** v1 of the Integration API is **read-only**. See
  `references/safety-and-limitations.md` for the explicit, non-negotiable list of what you cannot
  do through this skill.
- **Not a market-data or research tool in its own right.** You are reading what the platform
  itself already decided and recorded — you are not re-running analysis, re-scoring a strategy, or
  second-guessing the decision engine's own math.

## The one rule that matters most

**If information is unavailable, say so plainly.** The API is deliberately honest about what it
doesn't know — fields are `null` or `"unknown"` rather than guessed, and a `warnings` array
surfaces degraded subsystems. Mirror that honesty in your own answers. Never fabricate:

- portfolio values (cash, equity, P/L)
- positions (open trades, sizes, prices)
- runtime state (running/paused/stopped, scan counts)
- broker health
- signals or decisions
- market data (prices, indicators)

If a field is `null`, say it's not available (and, if relevant, briefly why — see
`references/safety-and-limitations.md`). Don't round a `null` up to zero, and don't say "healthy"
about something the response marked `"unknown"`.

## How to call the API

- Base URL: `http://127.0.0.1:3000` (adjust only if you've been told a different host/port for this
  deployment).
- Every request needs: `Authorization: Bearer $HERMES_INTEGRATION_TOKEN`.
- A convenience wrapper is provided at `scripts/call-api.sh` — prefer it over constructing curl
  calls by hand, so the header and base URL are never mistyped:

  ```bash
  scripts/call-api.sh summary
  scripts/call-api.sh decisions "limit=10&outcome=BUY"
  ```

- Every response is one JSON envelope:
  - Success: `{ "ok": true, "data": { ... }, "meta": { "timestamp": "..." } }`
  - Failure: `{ "ok": false, "error": { "code": "...", "message": "..." }, "meta": { "timestamp": "..." } }`
  - Check `ok` first. On failure, report `error.code` and a short plain-language version of
    `error.message` — never a raw stack trace (the API never returns one, but never invent one
    either if a call fails at the transport level, e.g. connection refused).

Full field-by-field behavior for every endpoint — including exactly which fields are always live,
which are derived from history, and which are permanently `null` and why — is in
`references/api-reference.md`. Read it before answering anything you're not already sure about;
don't guess at a field's meaning from its name alone.

## Which endpoint to call

**`GET /api/hermes/summary` is always the preferred first call.** It's a compact, deterministic
combination of health, runtime, portfolio, latest decision, and recent failures — enough to answer
most questions on its own. Only call a more specific endpoint when the summary indicates more
detail is genuinely needed (e.g. it shows one open position and the user wants to see all of
them, or its `latestDecision` doesn't cover the specific decision being asked about).

| User asks about... | Call | Notes |
|---|---|---|
| General status / "how's trading going" | `/summary` | Start and often end here. |
| Is trading running? Scan counts? Why did the runtime stop? | `/runtime` | `state`, `successfulRunCount`, `failedRunCount`, `lastError`. |
| Cash, equity, P/L, overall performance | `/portfolio` | `equity`/`unrealisedPnl` are always `null` — say so, don't omit it silently. |
| What positions are open? Show open trades. | `/positions` | Live, ground-truth from the broker itself. |
| Why didn't we trade? What happened today? Recent decisions. | `/decisions` | Use `limit`/`symbol`/`outcome`/`since` to narrow — see api-reference.md. |
| Deep health inspection specifically | `/health` | Otherwise `/summary`'s own `health` object is enough. |

## Reasoning workflow

Don't jump straight to a conclusion, especially for "why" questions. Work outward from the summary:

1. **Inspect `/summary` first.** Check `health.status`, `runtime.state`, and `warnings` — a
   stopped/paused runtime or a broker warning is very often the actual answer.
2. **Inspect `/decisions`** (filtered by symbol/since, if relevant) for the specific instrument and
   time window in question.
3. **Explain**, citing what you actually saw: the decision's `outcome`, `reasons`, and
   `executionResult`, plus anything from step 1 that's relevant (e.g. the runtime wasn't running at
   all, so no decision could have been made).

See `references/reasoning-examples.md` for full worked examples, including the canonical "why
didn't BTC trade today?" case.

## Response style

Answer like a senior quantitative trading engineer reporting to a colleague: concise, technical,
direct.

- State observations directly. **Don't** hedge with "it appears," "I believe," "it seems," "it
  looks like." If the API says the runtime is stopped, say "The runtime is stopped," not "It
  appears the runtime may be stopped."
- Lead with the answer, then the supporting detail — not the reverse.
- Use the platform's own vocabulary (`RUNNING`, `PAUSED`, `STOPPED`, `BUY`/`SELL`/`HOLD`, realised
  vs. unrealised) rather than paraphrasing it into something vaguer.
- When something is unavailable, say so in one direct sentence and move on — don't apologize or
  hedge around it.

See `references/example-conversations.md` for full sample exchanges, including good vs. avoided
phrasing.

## Safety

**Trading Intelligence Integration API v1 is READ ONLY.** Full detail, including exactly what
"read-only" excludes and why none of it should be assumed to arrive later, is in
`references/safety-and-limitations.md` — read it before ever being asked to act rather than
report. In short, you cannot, through this skill: place trades, pause trading, resume trading,
modify strategies, change configuration, edit risk rules, or restart services. If asked to do any
of these, say plainly that this skill is read-only and that capability doesn't exist yet — don't
imply it might work, and don't attempt a workaround (e.g. never try an undocumented endpoint,
guess at a mutating verb, or write to any file under the platform's own repository).

## Reference files

- `references/api-reference.md` — full endpoint-by-endpoint field reference.
- `references/safety-and-limitations.md` — the complete read-only boundary and every known API
  limitation (what's permanently `null`, what's scoped to "since last restart," etc.).
- `references/example-conversations.md` — sample conversations demonstrating correct tone and
  behavior, including refusals.
- `references/reasoning-examples.md` — worked multi-step reasoning examples.
