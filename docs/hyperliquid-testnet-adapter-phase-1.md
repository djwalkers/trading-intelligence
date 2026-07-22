# Hyperliquid Testnet Adapter — Phase 1

Proves that Execution MVP Phase 1's broker abstraction (`PaperBroker`) can be implemented against a
real external venue — Hyperliquid's testnet — and complete one full order lifecycle (connect →
place → fill/cancel → close → verify flat), without touching autonomous strategy execution,
mainnet, or anything in Hermes Lab.

**`LocalPaperBroker` remains the default and unmodified.** Nothing about Execution MVP Phase 1's
strategy loading, signal evaluation, risk evaluation, audit event shapes, or fixture-replay CLI
(`npm run execution:demo`) changed. This phase adds a second, independent broker implementation and
a way to select it — it does not touch the first one.

## Architecture

```
Existing Execution Engine (unchanged: signal engine, risk engine, execution runner)
        │
        ▼
Existing Broker Interface (PaperBroker — unchanged, no new methods added)
        │
        ├── LocalPaperBroker            (Execution MVP Phase 1 — still the default)
        │
        └── HyperliquidTestnetBroker    (this phase)
                │
                ▼
        Hyperliquid Testnet (api.hyperliquid-testnet.xyz — never mainnet)
```

### New files

```
src/lib/hermes-execution/
├── broker-factory.ts                        getBroker() — selects Local vs Hyperliquid-testnet
└── hyperliquid/
    ├── price-formatting.ts                   Hyperliquid's real price/size rounding rules
    └── hyperliquid-testnet-broker.ts         HyperliquidTestnetBroker (+ HyperliquidOrderRestingError)

src/hermes-execution/
└── broker-testnet-smoke.ts                   CLI entrypoint (`npm run broker:testnet-smoke`)

tests/hermes-execution/
├── broker-factory.test.ts
└── hyperliquid/
    ├── price-formatting.test.ts
    ├── config-broker-provider.test.ts
    └── hyperliquid-testnet-broker.test.ts    All mocked at the @nktkas/hyperliquid SDK boundary
```

### Why `HyperliquidTestnetBroker` doesn't just implement `PaperBroker` as-is

`PaperBroker.getAccount()`/`getOpenPositions()`/`getCompletedTrades()` are synchronous, but live
exchange state can only be read asynchronously. `HyperliquidTestnetBroker` keeps a cached snapshot,
refreshed by `connect()` and by every `placeMarketOrder()`/`closePosition()` call — never a live
poll. It also exposes a few adapter-specific methods that aren't part of the shared interface,
because `LocalPaperBroker` has no equivalent concept and widening the shared interface for them
wasn't "genuinely necessary" per this phase's brief:

- `connect()` — establishes the asset universe and an initial account snapshot. Must be called once
  before any other method (the broker factory does this automatically).
- `cancelOrder(coin, oid)` — cancels a resting order. `LocalPaperBroker` fills every order
  instantly, so it has nothing to cancel.
- `getMidPrice(coin)` — used by the smoke test to size and price-bound its test order.
- `hasInstrument(coin)` / `getRawFills()` — confirmation and reporting helpers for the smoke test.

Only positions opened through a given `HyperliquidTestnetBroker` instance are tracked — this is a
connectivity/smoke-test adapter, not a general-purpose account manager. A pre-existing position on
the configured account (opened by something else) is invisible to `getOpenPositions()` by design.

### SDK

[`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) (there is no SDK published by
Hyperliquid itself — its own docs point developers at community SDKs, and this is the actively
maintained TypeScript one) + [`viem`](https://viem.sh) for wallet signing
(`privateKeyToAccount`). `HttpTransport({ isTestnet: true })` is hard-coded in the adapter's
constructor — never derived from any config value — and the constructor asserts
`transport.isTestnet === true` a second time before proceeding, so there is no code path that could
ever point this adapter at `api.hyperliquid.xyz` (mainnet).

## Required environment variables

See `.env.example` for full per-variable documentation (placeholders only — no real values are
committed anywhere). Summary:

| Variable | Default | Notes |
|---|---|---|
| `BROKER_PROVIDER` | `local` | `local` or `hyperliquid-testnet`. No `mainnet`/`live` value exists. |
| `HYPERLIQUID_TESTNET_PRIVATE_KEY` | unset | Required (paired) only when `BROKER_PROVIDER=hyperliquid-testnet`. Never logged. |
| `HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS` | unset | Required (paired) only when `BROKER_PROVIDER=hyperliquid-testnet`. |
| `HYPERLIQUID_TESTNET_EXECUTION_ENABLED` | `false` | A second, independent gate — must be explicitly `true`. |
| `HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD` | `15` | Floor of `10` enforced (Hyperliquid's own minimum order notional). |
| `HYPERLIQUID_TESTNET_INSTRUMENT` | `BTC` | The perp the smoke test trades. |

There is no environment-variable convention imposed by the SDK itself (it's configured entirely via
constructor options, not env vars) — the names above are this project's own, following the naming
pattern the task specified.

## Wallet/account preparation steps

1. Generate a **dedicated** EVM wallet for this purpose — never reuse a wallet that holds anything
   of real value on any network. Testnet compromise should never be able to cost you anything.
2. Fund it with **testnet** USDC via Hyperliquid's testnet faucet (see
   [Hyperliquid's docs](https://hyperliquid.gitbook.io/hyperliquid-docs) for the current faucet
   process — this changes over time and isn't reproduced here).
3. Set `HYPERLIQUID_TESTNET_PRIVATE_KEY` to that wallet's private key and
   `HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS` to its address, in `.env.local` (already `.gitignore`d —
   never commit these).
4. Set `BROKER_PROVIDER=hyperliquid-testnet` and `HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true`.

## How to run the smoke command

```bash
cd platform/web
BROKER_PROVIDER=hyperliquid-testnet \
HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true \
HYPERLIQUID_TESTNET_PRIVATE_KEY=0x... \
HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS=0x... \
npm run broker:testnet-smoke
```

(Or set the four vars in `.env.local` and just run `npm run broker:testnet-smoke` — it's picked up
automatically via `--env-file-if-exists=.env.local`, same as every other CLI in this project.)

It does **not** run during `npm run dev`/`npm run build`/app startup — it's only ever invoked
explicitly, exactly like `npm run execution:demo` and `npm run worker`.

## Safety boundaries

- **No mainnet support exists.** Not "disabled" — structurally absent. `BrokerProvider`'s type is
  `"local" | "hyperliquid-testnet"`; there is no third value anywhere in this codebase, and the
  adapter's transport is hard-coded `isTestnet: true` with a redundant runtime assertion.
- **Two independent gates**, both required: `BROKER_PROVIDER=hyperliquid-testnet` selects the
  adapter; `HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true` is a second, separate flag the broker
  factory checks before ever constructing the adapter. Neither alone is sufficient.
- **Never falls back.** An unrecognised `BROKER_PROVIDER`, missing credentials, or the execution
  flag left off all throw a clear error — none of them silently default to `local` or anything else.
- **Bounded order size.** `HYPERLIQUID_TESTNET_MAX_ORDER_VALUE_USD` (default $15) caps every test
  order; the smoke test always sizes to this cap, never a strategy-decided amount.
- **Correlation id on every order.** Each submitted order carries a unique 16-byte client order id
  (`cloid`), derived from the execution run id plus a per-broker-instance sequence counter — both
  Trading Intelligence's own audit correlation key and Hyperliquid's own duplicate-order signal.
- **Secrets never logged or committed.** The private key never appears in any audit event, log
  line, or thrown error message anywhere in this adapter (`tests/hermes-execution/hyperliquid/hyperliquid-testnet-broker.test.ts`
  asserts this directly against every recorded audit event and every thrown error). `.env.local` is
  `.gitignore`d; `.env.example` holds placeholders only.
- **No live-money path exists anywhere.** This phase adds exactly one new broker implementation,
  targeting exactly one non-production endpoint (`api.hyperliquid-testnet.xyz`).

## Expected output

A passing run prints, in order: configuration validated → connected → sanitised account info (a
truncated address, account value, withdrawable balance — never the private key) → test instrument
confirmed → mid price and order size → order filled (or a resting order, cancelled) → position
closed with realised P/L → confirmation that no position remains open → `SMOKE TEST PASSED`, exit
code 0. Any failure at any step prints a clear reason and `SMOKE TEST FAILED`, exit code 1 — the
script still attempts cleanup (cancel/close) before reporting failure wherever it safely can.

## Cleanup behaviour

Every code path leads to a flat account:

- **Order fills immediately** → the script closes the resulting position with an opposite,
  reduce-only order, then verifies via `getOpenPositions()` that nothing remains open for the test
  instrument.
- **Order rests unfilled** (`HyperliquidOrderRestingError`) → the script cancels it via
  `cancelOrder()`; no position was ever opened, so there is nothing further to close.
- **Close order rests unfilled** → the script cancels that resting order too and reports failure
  (a position may remain open — the final summary says so explicitly rather than claiming success).

The command is safe to run more than once: each run gets a fresh, timestamped execution-run id, a
fresh audit log file (`.data/hermes-execution/smoke-audit-log.json`, overwritten each run, not
accumulated), and a fresh set of client order ids — nothing about a previous run's state is reused
or assumed.

## Real network proof

**Pending.** No Hyperliquid testnet credentials were available while building this phase, so the
manual `npm run broker:testnet-smoke` command has not been run against the real network. Everything
above the smoke command itself — the adapter's request/response mapping, price/size formatting,
safety gating, and cleanup logic — is proven only via mocked SDK responses
(`tests/hermes-execution/hyperliquid/`, 234/234 tests passing including the pre-existing Execution
MVP Phase 1 suite). When credentials are available, run the command above and confirm a real
`SMOKE TEST PASSED` with a genuine filled order, closed position, and zero remaining exposure.

## Known limitations

- **`FrontendMarket` limit orders, not Hyperliquid's separate trigger-order market type.** The
  adapter submits a marketable IOC-style limit order bounded 5% away from the current mid (in the
  filling direction) rather than a stop/trigger market order — appropriate for a small, immediately
  fillable smoke-test order on a liquid instrument, not a general slippage-control strategy.
- **Only long ("BUY") entries are supported**, mirroring `LocalPaperBroker`'s own Phase 1 scope —
  `placeMarketOrder` throws clearly if asked to open a short.
- **Only one instrument's exposure is tracked per broker instance.** Fine for a one-order smoke
  test; a real trading adapter would need per-instrument position bookkeeping to match, not just
  track, whatever the exchange actually reports.
- **Account/position reads are a cached snapshot, refreshed after each mutating call — not a live
  poll.** A long-running process would want to refresh on a timer or before every decision; this
  phase only refreshes when it has just changed something itself.
- **No retry/backoff on transient network failures.** A dropped connection during `connect()` or an
  order call fails the whole run rather than retrying — acceptable for a manual smoke test, not for
  autonomous operation.

## Exact next step

Per this phase's stop condition: **do not connect autonomous strategy execution to Hyperliquid yet,
do not add live market-data streaming, do not add scheduling, do not begin mainnet support.** The
next phase, when undertaken, would be either (a) running the manual smoke test against real
testnet credentials to get the pending real-network proof, or (b) wiring `ExecutionRunner` to
optionally run the existing fixture-replay demo strategy against `HyperliquidTestnetBroker` instead
of `LocalPaperBroker` — using the exact same broker factory this phase already built — while still
stopping short of autonomous, unattended operation.
