# Declarative Strategy Foundation — Phase 1

**Status:** Schema + registry + read-only CLI foundation. No strategy defined here is wired into any
live trading decision, the executable `Strategy` interface, or the external Hermes registry. No
runtime, risk, execution, approval, lifecycle, reconciliation, sizing, stop-loss, take-profit, or
kill-switch behaviour changes as a result of this phase.

## Purpose

A strategy definition here is **validated data, never executable code** — no formula strings, no
expression evaluation, no dynamic import, no function bodies. This is the first step toward an
evidence-backed, versioned strategy catalogue that can later feed backtesting and Hermes context
generation, replacing "a strategy is whatever code happens to run" with "a strategy is a declared,
validated document with a stable identity."

## Relationship to existing strategy concepts (read this before touching any of these three)

This codebase already has three unrelated "strategy" concepts. Phase 1 adds a **fourth, deliberately
separate** one and touches none of the existing three:

1. **`strategies/strategy.ts`'s `Strategy` interface** (`InMemoryStrategyRegistry`) — executable
   TypeScript classes (`checkEntryConditions`/`evaluate`/etc.) that actually drive live trading
   decisions today. Untouched.
2. **`registry-client.ts`'s `FileSystemRegistryClient`** — reads the **external** Hermes Lab
   research-hypothesis registry from `HERMES_STRATEGY_REGISTRY_PATH`, a path **outside this repo**,
   with string-based `entryDefinition.rule`/`exitDefinition.rule`. Untouched; no shared directory, no
   shared schema version, no shared code.
3. **`src/lib/strategy-engine/`, `src/lib/types/strategy.ts`** — other, pre-existing, unrelated
   "Strategy" concepts noted in `strategies/strategy.ts`'s own top-of-file comment. Untouched.
4. **Phase 1 (this phase): `strategy-definitions/`** — a new, standalone, pure schema + read-only
   filesystem registry for hand-authored, source-controlled declarative strategy documents. Nothing
   here is registered with `InMemoryStrategyRegistry`, read by `strategy-loader.ts`, or reachable from
   any live decision path.

## Files

- `src/lib/hermes-execution/strategy-definitions/strategy-definition.ts` — schema types, enums, the
  prohibited-field scanner, and `validateStrategyDefinition()`. Pure — no I/O, no broker/execution/
  approval/lifecycle/risk import, no network call.
- `src/lib/hermes-execution/strategy-definitions/strategy-definition-registry.ts` — the (also pure
  read-only, filesystem-only) loader: `loadStrategyDefinitions()`, `selectLatestVersions()`,
  `versionHistory()`.
- `strategies/` (repo root of `platform/web`) — source-controlled, hand-authored strategy JSON files.
  Filename convention: `<strategyId>__<strategyVersion>.json` (informational only — never trusted
  over the document's own fields).
- `src/hermes-execution/strategy-catalogue-cli.ts` — read-only CLI (`npm run strategy:catalogue`).

A future phase's **generated** backtest/promotion evidence belongs in its own
`.data/hermes-execution/...` directory (gitignored), analogous to the Phase 0 instrument-catalogue
evidence directories — never mixed into the source-controlled `strategies/` directory. No such
directory exists yet; Phase 1 produces no generated evidence.

## Architectural boundary — what a strategy document can and cannot control

A strategy definition may describe: supported instruments, timeframe, required market-data fields,
indicators, entry rules, optional signal-level exit rules, parameters, metadata, backtesting
assumptions, and eligibility constraints.

A strategy definition may **never** control: order size, leverage, portfolio limits, maximum open
positions, stop-loss calculation, take-profit calculation, the kill switch, broker provider, account
mode, approval mode, execution routing, lifecycle transitions, reconciliation, or live-vs-demo mode.

If a document contains any such field — at **any** depth, under any key name variant
(`stop_loss`, `StopLoss`, `STOP-LOSS-PERCENT` all match the same rule) — it is **rejected outright**
(`PROHIBITED_FIELD`), never silently stripped or ignored. See `findProhibitedFields()`.

## Status is declared metadata only

`status` (`DRAFT | VALIDATED | APPROVED_FOR_BACKTEST | APPROVED_FOR_DEMO | RETIRED | DISABLED`) is
whatever the document itself says — Phase 1 does not verify it against any external review process.
Critically: **`usableForDemo` is unconditionally `false` in this phase**, regardless of a document
declaring `status: "APPROVED_FOR_DEMO"` — there is no promotion mechanism yet to trust that claim.
`usableForBacktest` is `true` only when the document is fully valid, `status` is
`APPROVED_FOR_BACKTEST` or `APPROVED_FOR_DEMO`, and at least one supported instrument exists in the
Phase 0 catalogue.

## Versioning

- `strategyId`: `^[A-Z][A-Z0-9_]*$` — stable, uppercase-snake-case.
- `strategyVersion`: strict `MAJOR.MINOR.PATCH` semver (no prerelease/build metadata in Phase 1) —
  rejected outright (`INVALID_STRATEGY_VERSION`) otherwise.
- **"Latest" means the highest semantic version**, compared numerically component-by-component
  (`compareSemver`) — never lexicographic string order (which would rank `"10.0.0"` below `"9.0.0"`)
  and never "most recently written file." Chosen deliberately over "newest timestamp" because the
  version format is (required to be) semver.
- No duplicate `strategyId`+`strategyVersion` pair survives: byte-for-byte identical duplicates
  contribute once; conflicting duplicates (same id+version, different content) are rejected
  (`CONFLICTING_DUPLICATE_VERSION`) — a `strategyVersion` must be immutable once published.
- Every accepted version is retained (`versionHistory()`, oldest-first by semver); older versions are
  never overwritten by a newer one.
- A newer version's `status`/validation result is **never** inherited from an older version — each
  file is validated entirely independently.

## Instrument capability boundary

A strategy may reference only `BTC`, `ETH`, `SOL` — the Phase 0 catalogue's own seed list. Validation
distinguishes four separate facts per referenced instrument (never conflated):

1. **Exists in the catalogue at all** — absence here is a hard rejection (`UNSUPPORTED_INSTRUMENT`):
   an unknown instrument (e.g. `"DOGE"`) means the platform has no data model for it whatsoever.
2. **In the configured runtime universe** (`configuredInUniverse`/`inConfiguredTradingUniverse`).
3. **Read-only capability verified** (`readOnlyCapabilityStatus === "READ_ONLY_VERIFIED"`).
4. **Stage-4 capability verified** (`stage4CapabilityStatus === "VERIFIED"`).

A catalogue-known instrument that isn't yet read-only-verified is **not** a hard rejection — it's a
`validationWarning` plus an entry in `unavailableInstruments`; the document itself can still be
otherwise valid ("marked unusable with an explicit reason," per this phase's own requirement).
Strategy loading never mutates catalogue state or runtime enablement — it only ever reads
already-built `InstrumentCatalogueEntry[]` (reusing Phase 0's own `buildInstrumentCatalogue`, never
duplicating broker metadata).

## Timeframe

Only `"1h"` is supported today (`SUPPORTED_TIMEFRAMES`). Adding a future timeframe means extending
that one array + its derived union type — never a schema redesign.

## Indicators

`EMA | RSI | ATR` only. Each indicator requires: a stable `id`, `type`, `sourceField` (one of
`open|high|low|close|volume`), `parameters.period` (positive integer), and a unique `outputAlias`.
An indicator object with any extra key (in particular a `formula`/`expression`/`script` field) is
rejected outright (`INVALID_INDICATOR`) — the exact, closed key set is enforced, never a loose
superset check.

## Entry rules — a typed tree, never a string

`RuleNode` is a discriminated union: `GREATER_THAN | LESS_THAN | GREATER_THAN_OR_EQUAL |
LESS_THAN_OR_EQUAL | BETWEEN | CROSSES_ABOVE | CROSSES_BELOW | AND | OR`. Operands may only be a
declared indicator's `outputAlias`, a safe market field, or a finite numeric constant — never a
formula, JavaScript, SQL, shell command, dynamic import, or function body (there is no operand kind
that could carry one).

The validator detects impossible/malformed trees:
- `AND`/`OR` with fewer than two child rules (a single-child boolean combinator is meaningless).
- Any comparison/`BETWEEN`/cross rule where **every** operand is a constant (e.g. `5 > 3`) — it can
  never depend on market data, so it is rejected as malformed rather than accepted as "always true."
- `BETWEEN` whose own tested operand is itself a constant, or whose `lowerBound >= upperBound` (a
  range that can never be true).
- A rule tree exceeding 64 total nodes (defensive bound against pathological trees).

## Signal-level exit rules

`SignalExitRule` is `{ kind: "CONDITION", rule: RuleNode }` (an opposing indicator condition, or
trend invalidation — the same typed tree as entry rules) or `{ kind: "MAX_BARS_HELD", maxBars }`.

**These are advisory only.** Deterministic, persisted stop-loss, take-profit, kill-switch, and
lifecycle protection remain entirely external to this schema and are the sole authority over actual
position exits — a strategy document declaring a signal exit never changes that.

## Example strategy: `CRYPTO_EMA_TREND_V1` (`1.0.0`)

`strategies/CRYPTO_EMA_TREND_V1__1.0.0.json` — an illustrative EMA20/EMA50 trend-following concept
for BTC/ETH/SOL on 1h, gated by an RSI(14) healthy range (45–70), with a `CROSSES_BELOW` signal exit
plus a 200-bar max-hold. `status: "APPROVED_FOR_BACKTEST"` (never `APPROVED_FOR_DEMO`). Not claimed
to be profitable — its own `limitations` array says so explicitly, along with "not yet backtested"
and "defines no sizing/leverage/stop-loss/take-profit." Not wired into any runtime execution path.

## Content hash — deterministic content identity, never approval

Every validated document gets a deterministic **SHA-256** content hash
(`result.provenance.contentHash`, hex-encoded, always paired with
`result.provenance.contentHashAlgorithm: "sha256"`), computed by `computeContentHash()`.

**What is hashed:** only the validated document itself (`schemaVersion` through `limitations` — the
exact same value that becomes `record.document`). **Never** included: the source file path, its
absolute directory, a load timestamp, any filesystem metadata (mtime, permissions, etc.), or any
environment value — none of those are part of `document` in the first place, so there is nothing to
accidentally leak into the hash.

**Canonicalisation (`canonicalStringify()`):** recursively sorts **object** keys so two documents
that differ only in source-JSON key order hash identically; **array** order is left untouched,
since order is semantically meaningful (`supportedInstruments`, `signalExitRules`, `AND`/`OR` child
rule order, etc.). Pure — never mutates the value it's canonicalising.

**One implementation, two uses (by design, so they cannot drift):** the registry's own
identical-vs-conflicting duplicate detection (`recordsEqual` in
`strategy-definition-registry.ts`) compares `provenance.contentHash` directly — it is not a second,
parallel re-implementation of canonicalisation; it reuses the exact same hash `validateStrategyDefinition`
already computed.

**The hash is content identity only.** It proves two documents are (or are not) canonically
identical — it is never, by itself, evidence that a strategy is approved, validated, or trusted for
backtest/demo use. That remains entirely the job of `status` + `usableForBacktest`/`usableForDemo`
(see "Status is declared metadata only" above), which the hash plays no part in deciding.

## `loadedAt` — operational provenance, not document content

`result.provenance.loadedAt` is the UTC ISO-8601 instant this process **validated and loaded** the
document — it means "when the registry processed this file," nothing about the strategy itself.

- **Generated by the registry/loader, never accepted from the strategy JSON.** There is no
  `loadedAt` field in the schema; one appearing in a strategy file is rejected exactly like any
  other unrecognised root field (`UNEXPECTED_SHAPE`).
- **Never derived from file modification time** — it is a clock read (real or injected), not
  filesystem metadata.
- **Excluded from the content hash and from strategy identity.** `contentHash` is computed from the
  document alone, before `loadedAt` is even attached to `provenance` — two validations of the exact
  same document with different `loadedAt` values always produce the identical `contentHash`, and the
  registry's duplicate-equality check (`recordsEqual`) compares `contentHash` alone, so `loadedAt`
  plays no part in "identical vs. conflicting" duplicate detection or in `selectLatestVersions`.
- **One shared clock per load operation.** `loadStrategyDefinitions(directory, catalogueEntries,
  { now })` calls `now()` exactly once per invocation and reuses that single value for every file
  processed in that call — every strategy loaded together in one catalogue generation shares an
  identical `loadedAt`. Two separate calls to `loadStrategyDefinitions` (two CLI runs, or two tests)
  may legitimately produce different `loadedAt` values; `validateStrategyDefinition()` itself also
  accepts an optional `loadedAt` argument (defaulting to the real current time) for direct/standalone
  callers.

## CLI

```bash
npm run strategy:catalogue
npm run strategy:catalogue -- --json
```

Read-only: never connects to a broker, never calls eToro, never invokes
`broker-etoro-smoke.ts`/`broker:etoro-probe`, never touches PM2. Reads the source-controlled
`strategies/` directory plus the existing, already-built Phase 0 instrument catalogue (read-only
evidence only). Prints one row per **latest version** of each `strategyId` (status,
`usableForBacktest`/`usableForDemo`, compatible instruments, total version count, and a concise
`hash=sha256:<first 8 hex chars>…` prefix); rejections are capped at 10 in human output (same policy
as `instrument:catalogue`). The full 64-hex-char digest is never printed in human output (it would
make every row excessively wide) — it is always available via `--json`
(`strategies[].result.provenance.contentHash`, and per-version in `strategies[].history[].contentHash`).
`loadedAt` is JSON-only (omitted from the compact human row, per this phase's own requirement) —
available at `strategies[].result.provenance.loadedAt` and per-version in
`strategies[].history[].loadedAt`; the CLI reads its clock once per invocation, so every strategy's
`loadedAt` matches the run's own `generatedAt` exactly.

## Validation result model

```
{ strategyId, strategyVersion, valid, usableForBacktest, usableForDemo,
  validationErrors, validationWarnings,
  supportedCatalogueInstruments, unavailableInstruments,
  prohibitedFieldsFound,
  provenance: { filePath, contentHash, contentHashAlgorithm, loadedAt } }
```

`usableForDemo` stays `false` unconditionally in this phase — see "Status is declared metadata only"
above. `provenance.contentHash`/`contentHashAlgorithm` are content identity only — see "Content
hash" above. `provenance.loadedAt` is operational (when this process loaded the file), never
document content — see "`loadedAt`" above.
