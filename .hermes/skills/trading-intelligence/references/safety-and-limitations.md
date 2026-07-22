# Safety and Limitations

## Trading Intelligence Integration API v1 is READ ONLY

Every endpoint under `/api/hermes/*` is a `GET`. None of them can:

- place a trade
- pause trading
- resume trading
- modify a strategy
- change configuration
- edit risk rules
- restart services

**None of these exist in v1, full stop.** They may exist in a future version — do not assume that,
do not hint that one might work if you just phrase the request differently, and do not try an
undocumented endpoint, a different HTTP method, or a workaround (e.g. writing to a file in the
platform's repository, or suggesting the user edit the running process directly) to accomplish any
of the above. If asked to do any of these, say plainly: *"This skill only reads Trading
Intelligence's state — it can't [pause/resume/place a trade/...]. That capability doesn't exist in
the current Integration API."* Then stop — don't offer an alternative unless the user asks for one,
and don't imply you attempted it.

This boundary is the API's own design, not a limitation of this skill specifically — see
`docs/hermes-integration-api.md` in the platform repository, "v1 is read-only."

## What Hermes must never invent

Regardless of how confident a guess might be, never invent:

- **portfolio values** — cash, equity, P/L of any kind
- **positions** — instrument, side, quantity, price, whether one exists at all
- **runtime state** — running/paused/stopped, scan/cycle counts
- **broker health** — connectivity, account status
- **signals or decisions** — what the decision engine concluded, or why
- **market data** — prices, indicators, trends

If a value isn't in the API response, it isn't available to you right now. Say so. Do not
substitute a value from an earlier turn in the conversation, a general assumption about "typical"
values, or an inference from a related field.

## Fields that are permanently `null` in v1 (not a bug, not "currently down")

These are architectural limits of v1, not transient failures — report them as "not available in
this version," not as an error or something to retry:

- `/api/hermes/runtime`'s `nextRunAt` — no live channel to the scheduler process exists.
- `/api/hermes/positions`' `currentPrice` and `unrealisedPnl` — no cheap live rate-per-position
  lookup exists yet.
- `/api/hermes/portfolio`'s `unrealisedPnl` and `equity` — same reason as above.

## Fields that are scoped, not all-time

- `realisedPnl` (in `/portfolio` and `/summary`) covers only trades closed **since the trading
  runtime's most recent restart** — its history resets whenever that separate process restarts.
  There is no all-time figure available through this API. If asked for lifetime/total P/L, say only
  the since-last-restart figure exists here.
- `successfulRunCount`/`failedRunCount`/`skippedOverlapCount` (in `/runtime` and `/summary`) are
  likewise scoped to the current run, resetting on every restart.

## `unknown`/`null`/failed calls are three different things — don't conflate them

- A field value of `"unknown"` (e.g. `runtime.state`) means the platform has no reliable way to
  determine it right now — report it as genuinely unknown, not as a guess toward the most likely
  state.
- A field value of `null` (e.g. `unrealisedPnl`) means this API deliberately never computes that
  figure — report it as "not available in this version."
- An error envelope (`"ok": false`) means the call itself failed — report the `error.code` and a
  short version of `error.message`. Do not treat a `503 BROKER_UNAVAILABLE` the same as "zero open
  positions" or "portfolio is empty" — it means the check couldn't be performed at all.

## Two processes, one platform

Trading Intelligence's web app and its trading runtime are two separate processes. Some fields
(runtime state, decisions, realised P/L) are read from a log file the runtime process writes and
the web app only reads — if that file is temporarily unavailable, those fields degrade to
`unknown`/`null`/empty honestly, not to a fabricated "everything's fine" default. This is expected
platform behavior, not something to alarm the user about beyond noting the data isn't available
right now.

## Instrument identifiers

Open eToro positions are identified by eToro's own numeric instrument ID, not a ticker symbol. If a
user asks "what's the BTC position's current price" and the position list only shows a numeric ID,
say you can see a position with that ID but don't have a human-readable symbol mapping in this
API version — don't guess that the ID corresponds to BTC just because that's what was asked about.
