# Execution MVP — Phase 1

The smallest working end-to-end paper-trading loop: Strategy Registry → Strategy Loader → Market
Data → Signal Evaluation → Risk Check → Local Paper Broker → Position and Trade Record. This phase
proves the machinery works; it deliberately trades a demo-only fixture strategy while Hermes Lab's
Strategy Registry continues to hold zero real, eligible strategies.

## Architecture

```
Hermes Strategy Registry (Hermes Lab, read-only)
        │
        ▼
Registry Consumer          FileSystemRegistryClient — locates the registry, loads & validates
                            strategy documents, rejects malformed/duplicate/unsupported-version
                            documents, treats an empty registry as valid
        │
        ▼
Internal Strategy Model    InternalStrategy — id, version, sourceType (HERMES_APPROVED |
                            DEMO_ONLY), enabled, instrument, timeframe, entry/exit/risk rules.
                            internal-strategy-mapper.ts is the only file that understands the
                            Hermes JSON schema; nothing downstream does.
        │
        ├── (registry strategies, mapped)
        └── (DEMO_ONLY strategy, only if DEMO_EXECUTION_MODE=true) ── demo-strategy.ts
        │
        ▼
Strategy Loader             Combines both sources into one enabled-strategy set; emits
                            STRATEGY_LOADED / STRATEGY_REJECTED audit events
        │
        ▼
Market Data Adapter         FixtureMarketDataProvider — deterministic local candle replay,
                            no network. A live provider only needs to implement the same
                            MarketDataProvider interface.
        │
        ▼
Signal Engine               evaluateSignal() — deterministic NO_ACTION / ENTER_LONG /
                            EXIT_POSITION decisions from a small closed rule vocabulary
                            (moving-average cross, take-profit, stop-loss). No LLM, no
                            arbitrary code execution from strategy JSON.
        │
        ▼
Risk Engine                 evaluateRisk() — 8 pre-trade checks, always all evaluated,
                            APPROVED or REJECTED with explicit reasons
        │
        ▼
Local Paper Broker          LocalPaperBroker — account, open positions, market orders,
                            close position, completed trades. Behind a PaperBrokerStore
                            adapter (JSON file for the CLI, in-memory for tests).
        │
        ▼
Execution Runner             Coordinates the above per candle, guarding against duplicate
                            candle/order/position/exit processing
        │
        ▼
Audit Trail                  Structured events for every stage, persisted to a local JSON
                            file and logged via the existing `logger`
```

### Files

```
src/lib/hermes-execution/
├── types.ts                        Shared types (InternalStrategy, Candle, SignalDecision, ...)
├── config.ts                       Env parsing — HERMES_STRATEGY_REGISTRY_PATH, EXECUTION_MODE,
│                                   DEMO_EXECUTION_MODE, starting cash, max open positions
├── registry-client.ts              FileSystemRegistryClient (+ validateRawStrategy)
├── internal-strategy-mapper.ts      Registry JSON -> InternalStrategy, or a clear rejection
├── demo-strategy.ts                 The one DEMO_ONLY strategy; null unless demo mode is on
├── strategy-loader.ts               Combines HERMES_APPROVED + DEMO_ONLY into one enabled set
├── array-utils.ts                   `at()` — bounds-checked array indexing (noUncheckedIndexedAccess)
├── fixture-market-data-provider.ts  FixtureMarketDataProvider (pure, no fs)
├── load-fixture-candles.ts          Reads + validates a local JSON candle fixture (server-only)
├── signal-engine.ts                 evaluateSignal()
├── risk-engine.ts                   evaluateRisk()
├── paper-broker-store.ts            PaperBrokerState + InMemoryPaperBrokerStore
├── json-file-paper-broker-store.ts  JsonFilePaperBrokerStore (server-only, .data/hermes-execution/)
├── paper-broker.ts                  PaperBroker interface + LocalPaperBroker
├── audit-trail.ts                   AuditTrail interface + InMemoryAuditTrail
├── json-file-audit-trail.ts         JsonFileAuditTrail (server-only)
├── execution-runner.ts              ExecutionRunner
└── status.ts                        Read-only status snapshot for the system-health panel

src/hermes-execution/
├── execution-demo.ts                 CLI entrypoint (`npm run execution:demo`)
└── fixtures/demo-candles.json        The 11-candle deterministic dataset

src/components/system-health/HermesRegistryStatusPanel.tsx   Operations Centre panel
tests/hermes-execution/                                       60 tests, deterministic fixtures
```

## Why an isolated pipeline, not a redesign

This app already has a mature bot/position-manager/portfolio-risk stack (`src/lib/bot/`) built for
its own heuristic strategies. That stack is untouched by this phase. The Hermes Strategy Registry
pipeline is deliberately a **separate, parallel path** — its own strategy representation, its own
risk engine, its own broker — because it answers a different question ("what has Hermes Lab's
research programme certified as eligible to trade?") using a different, external source of truth.
Nothing in `src/lib/bot/` was modified; nothing in this pipeline is wired into it.

## Configuration

See `.env.example` for full per-variable documentation. Summary:

| Variable | Default | Notes |
|---|---|---|
| `HERMES_STRATEGY_REGISTRY_PATH` | unset ("not configured") | Absolute path to a Hermes Lab `strategy-registry/` directory |
| `EXECUTION_MODE` | `paper` | Only `paper` is supported; anything else fails closed |
| `DEMO_EXECUTION_MODE` | `false` | Must be explicitly `true` to load the DEMO_ONLY strategy |
| `HERMES_PAPER_STARTING_CASH` | `10000` | Virtual starting cash |
| `HERMES_MAX_OPEN_POSITIONS` | `5` | Strategy-level risk engine's cap (`RiskEngineConfig.strategyMaxOpenPositions`); the separate, portfolio-level `PortfolioRiskConfig.portfolioMaxOpenPositions` used by the Milestone 4 pipeline is not sourced from an env var |

## How to run the demo

```bash
cd platform/web
HERMES_STRATEGY_REGISTRY_PATH=/absolute/path/to/hermes-lab/strategy-registry \
DEMO_EXECUTION_MODE=true \
npm run execution:demo
```

`HERMES_STRATEGY_REGISTRY_PATH` may also be set in `.env.local` (picked up automatically via
`--env-file-if-exists=.env.local`, the same convention as `worker`/`refresh-universe`). Without
`DEMO_EXECUTION_MODE=true`, the run will correctly report zero enabled strategies and stop — this
is the honest, expected state of a real Hermes registry with nothing eligible yet, but it is **not**
the proof-of-life run: use `DEMO_EXECUTION_MODE=true` to exercise the full lifecycle.

## Completed trade evidence

A real run against the actual (empty) Hermes Lab strategy-registry, with demo mode enabled:

```
Hermes Execution MVP — Demo Replay
===================================
Execution mode: paper
Registry connected: true (.../Hermes Lab/strategy-registry)
0 Hermes-approved strategies loaded
Demo execution mode: enabled
Demo strategy loaded: true
Fixture replay started: 11 candles loaded from .../src/hermes-execution/fixtures/demo-candles.json

Execution trace
----------------
[CANDLE_PROCESSED] DEMO-USD close=100                       (x5 — building the moving average)
[SIGNAL_GENERATED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD -> NO_ACTION: Not enough history yet ...
[CANDLE_PROCESSED] DEMO-USD close=103
[SIGNAL_GENERATED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD -> ENTER_LONG: Close 103 crossed above the
  5-period moving average (100.6000); previous close 100 was at or below its own moving average.
[RISK_APPROVED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD                       (all 8 checks passed)
[ORDER_SUBMITTED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD BUY qty=4 @ 103
[POSITION_OPENED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD position-1 entryPrice=103 qty=4
[CANDLE_PROCESSED] DEMO-USD close=103.5 / 104               (holding, no exit condition met)
[CANDLE_PROCESSED] DEMO-USD close=105.5
[SIGNAL_GENERATED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD -> EXIT_POSITION: Close 105.5 reached the
  take-profit level 105.0600 (+2% from entry 103).
[POSITION_CLOSED] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD position-1 exitPrice=105.5
[REALISED_PNL] DEMO-0001 v1 (DEMO_ONLY) DEMO-USD trade-1 realisedPnl=10
[CANDLE_PROCESSED] DEMO-USD close=105 / 104                 (no re-entry — close never re-crosses)

Replay completed successfully.

Summary
-------
Starting balance: 10000.00
Ending balance: 10010.00
Completed trade count: 1
Realised P/L: 10.00
Open position count: 0
Candles processed: 11
Entries opened: 1
Exits closed: 1
Risk rejections: 0
```

Also verified:
- **Demo mode disabled (default)**: `0 Hermes-approved strategies loaded`, `Demo strategy loaded:
  false`, "No enabled strategies — nothing to replay", exit code 0 — correct, not a failure.
- **`HERMES_STRATEGY_REGISTRY_PATH` unset**: clear error message, exit code 1, no stack trace leak.
- **`EXECUTION_MODE=live`**: fails closed with `ConfigError: Expected one of paper, received
  "live"`, caught cleanly, exit code 1 — there is no live path to fall back to.
- **Duplicate candle / duplicate order / double-exit guards**: covered by
  `tests/hermes-execution/execution-runner.test.ts` (a candle repeated in the same feed is only
  processed once; running the same `ExecutionRunner` instance twice creates no second trade).

## Validation performed

- `npx tsc --noEmit` — passes, zero errors
- `npm run lint` — passes, zero warnings
- `npm run build` — succeeds; `/system-health` (with the new panel) prerenders
- `npm test` — 196/196 tests pass (136 pre-existing + 60 new), across 36 files
- `HermesRegistryStatusPanel` verified two ways: (1) a component test
  (`tests/hermes-execution/hermes-registry-status-panel.test.tsx`) covering the empty state, an
  active-demo-trade state, and the not-configured state; (2) a direct fetch of the server-rendered
  `/system-health` HTML confirming every expected label renders with no server error — full
  interactive browser verification was not possible because this app's `AuthGate` requires
  Supabase sign-in for every route, and creating an account or entering credentials to get past it
  is outside what this assistant will do unprompted; see Known Limitations.
- Hermes Lab confirmed unmodified: `git status` on the Hermes Lab repo before and after this phase
  shows no new modifications (only the same pre-existing untracked directories); no write/delete
  filesystem call exists anywhere in `src/lib/hermes-execution/` (`registry-client.test.ts`'s
  "no Hermes file is modified" suite mocks `node:fs/promises`'s write-shaped exports and asserts
  they are never called, plus a live checksum-diff test against the real sibling registry when
  present).
- No secrets committed: `.env.local` (where the real Supabase keys and this phase's local
  `HERMES_STRATEGY_REGISTRY_PATH`/`DEMO_EXECUTION_MODE` values live) is `.gitignore`d and was never
  staged; only `.env.example` (no real values) was edited.
- No real broker order path exists anywhere in this phase — `LocalPaperBroker` is the only broker
  implementation, `PaperBroker` is its only interface, and nothing references a live venue,
  Hyperliquid, or Trading 212.

## Known limitations

- **State resets every run, by design.** `npm run execution:demo` always starts the paper broker
  and audit trail from a clean slate (`resetState: true`) so the replay is byte-for-byte
  reproducible regardless of what a previous run left in `.data/hermes-execution/`. This is correct
  for a demo/proof command; a long-running process would want `resetState: false` instead (already
  supported by `LocalPaperBroker.create`, just not exercised by the CLI).
- **The internal-strategy-mapper's rule convention is Trading-Intelligence-only.** The Hermes
  schema's `entryDefinition`/`exitDefinition.parameters` are generic `object` fields by design;
  this phase defines its own small closed convention for what a *structured, executable* rule looks
  like inside them (see the doc comment at the top of `internal-strategy-mapper.ts`). No real
  registry strategy exists yet to exercise this against, so it is currently proven only by unit
  tests with hand-built fixture documents — genuinely correct, but not yet battle-tested against a
  real Hermes-produced strategy record.
- **Order sizing is a simple `floor(maxPositionValue / price)`.** No fractional shares, no
  slippage/commission modeling — appropriate for proving the loop, not for realistic P&L.
- **The Operations Centre panel could not be visually verified in a live browser** because every
  route in this app sits behind Supabase-backed sign-in, and creating an account or supplying
  credentials to get past that gate is a boundary this assistant does not cross unprompted.
  Verified instead via a direct fetch of the server-rendered HTML (all expected labels present, no
  500) and a full component test suite with mocked status data.
- **`ENTER_SHORT` exists in the type system but is never produced.** No short-entry rule is defined
  in this phase's rule vocabulary; it's reserved so a future rule type doesn't require a breaking
  change to `SignalAction`.

## Exact next step

Per the stop condition for this phase: **do not begin external broker integration, do not add
another dashboard phase, do not add additional strategies.** The next phase replaces one of the two
temporary adapters — the local paper broker, or the fixture market-data adapter — with an external
test environment (a sandbox broker API, or a live/delayed market-data feed), while preserving this
phase's execution loop (signal engine, risk engine, execution runner, audit trail) unchanged. Both
`PaperBroker` and `MarketDataProvider` were built as clean, minimal interfaces specifically so that
swap does not require touching anything upstream of them.
