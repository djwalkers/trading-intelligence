# Instrument Catalogue — Phase 0

**Status:** Read-only foundation. No broker order, no Stage 4 execution, no PM2 action, no live
trading behaviour change, no new instrument enabled. See
[`ETORO_INSTRUMENT_CAPABILITY_PLAN.md`](./ETORO_INSTRUMENT_CAPABILITY_PLAN.md) and
[`INSTRUMENT_UNIVERSE_DESIGN.md`](./INSTRUMENT_UNIVERSE_DESIGN.md) for the plans this implements.

## Purpose

Ingests the read-only eToro capability probe's schema-version-2 evidence
(`.data/hermes-execution/etoro-capability-evidence/*.json`, produced by
`npm run broker:etoro-probe`) into a small, typed catalogue — the first step toward an
authoritative, evidence-backed instrument catalogue, replacing "assume every configured symbol
works" with "state only what has actually been verified."

## Evidence source

- Directory: `.data/hermes-execution/etoro-capability-evidence/`
- One JSON file per probe run+instrument, each a one-element array whose `details` field is the
  evidence document (see `etoro-instrument-probe.ts`'s own `InstrumentEvidenceDocument`).
- The append-only pointer log (`etoro-instrument-probe-log.json`) is never read as evidence — only
  files inside the evidence directory, validated against the full document shape.

## Schema-version rule

`schemaVersion < 2` is rejected outright (`SCHEMA_VERSION_TOO_OLD`). Schema-version-1 evidence
predates a real quote-freshness classification defect and must never seed the catalogue.

## Validation rules (beyond shape)

- **Symbol match (`SYMBOL_MISMATCH`)** — for a successful resolution, `resolution.resolved.symbol`
  must match the document's own requested `instrument` after the one normalisation rule this module
  applies (trim + uppercase, the same convention `config.ts` uses for
  `HERMES_INSTRUMENT_UNIVERSE` entries). A document claiming `instrument: "BTC"` with
  `resolution.resolved.symbol: "ETH"` is rejected outright and contributes to no catalogue row.
- **Temporal fields** — `startedAt` and `completedAt` must both be parseable timestamps, and
  `completedAt >= startedAt` (`INVALID_TIMESTAMP_ORDER` otherwise). Dates are never guessed or
  repaired.
- **`appVersion`** — required, non-empty string (same missing-field rejection model as `runId`/
  `instrument`/etc.).
- **Future-timestamp guard (`FUTURE_TIMESTAMP`)** — `completedAt` must be no later than catalogue
  generation time plus a small, documented clock-skew tolerance
  (`FUTURE_TIMESTAMP_TOLERANCE_MS`, 5 minutes). Evidence beyond that tolerance is rejected outright
  so it can never win "latest" precedence just by claiming a future timestamp. "Now" is injectable
  (`{ nowMs }` on both `validateEvidenceDocument` and `loadCapabilityEvidence`) for deterministic
  tests.
- **`accountMode`** — the schema-version-2 evidence document (`etoro-instrument-probe.ts`'s
  `ProbeConfiguration`) has no separate `accountMode` field; `brokerProvider` (`"etoro-demo"`) is
  the only account-mode signal that exists. This module still requires `brokerProvider ===
  "etoro-demo"` exactly and rejects anything else (`UNSUPPORTED_PROVIDER`/
  `UNSUPPORTED_ACCOUNT_MODE`) — it does not fabricate a dedicated `accountMode` field the schema
  doesn't have.

## Status meanings

| Field | Values |
|---|---|
| `readOnlyCapabilityStatus` | `NOT_TESTED`, `UNSUPPORTED`, `PARTIALLY_SUPPORTED`, `READ_ONLY_VERIFIED` |
| `stage4CapabilityStatus` | `NOT_TESTED`, `VERIFIED`, `FAILED` (no Stage-4 evidence source is ingested yet — always `NOT_TESTED` in this phase) |
| `effectiveCapabilityStatus` | Never becomes `VERIFIED` from read-only evidence alone. `VERIFIED` requires `stage4CapabilityStatus === "VERIFIED"`; a Stage-4 `FAILED` dominates; otherwise it mirrors `readOnlyCapabilityStatus`. |

## Precedence rules (multiple evidence files)

1. Every accepted file for an instrument is sorted by `(completedAt, runId)`.
2. The chronologically **latest** trustworthy run is authoritative — never the "best" one. A newer
   `PARTIALLY_SUPPORTED` or `UNSUPPORTED` run correctly supersedes an older `READ_ONLY_VERIFIED`
   run; nothing is silently ignored.
3. Every accepted run is retained in the entry's own `history` array (oldest first).
4. A malformed/incomplete file (bad JSON, missing required field, unparseable date, invalid
   timestamp ordering, future-dated beyond tolerance, symbol mismatch, wrong provider, non-demo
   account) is rejected with an explicit reason — never guessed or silently dropped.
5. The document's own `instrument` field is authoritative; the filename is never trusted.
6. **Duplicate `runId`** — evidence files sharing a `runId` are deduplicated before precedence is
   computed: byte-for-byte identical duplicates contribute once; duplicates that disagree on any
   field are rejected outright (`CONFLICTING_DUPLICATE_RUN_ID`) rather than silently tie-broken.
   Resolution is grouped by `runId`, never by directory enumeration order, so it is deterministic
   regardless of file listing order.
7. **Symbolic links** inside the evidence directory are rejected (`SYMLINK_REJECTED`), never
   followed — a symlink cannot be used to read a file outside the evidence directory.
8. The append-only pointer log (`etoro-instrument-probe-log.json`) is excluded **by filename**
   before any parse/validate attempt — it is never counted as a rejected/malformed file.

## Capability vs. configured universe vs. trading enablement

These are three deliberately independent facts:

- **Capability** (`readOnlyCapabilityStatus`/`effectiveCapabilityStatus`) — what evidence says the
  broker can actually do for this symbol.
- **Configured universe** (`configuredInUniverse`) — whether the symbol is present in
  `config.hermesAgent.instrumentUniverse` today, read directly from existing configuration.
- **Configured trading universe membership** (`inConfiguredTradingUniverse`) — today, exactly
  `configuredInUniverse` (there is no other independent per-instrument enablement toggle in the
  current system). It is **never** derived from capability evidence — a `READ_ONLY_VERIFIED` (or
  even a hypothetical future `VERIFIED`) instrument that isn't configured stays `false`. Named
  `inConfiguredTradingUniverse`, not `tradingEnabled` — the field proves config-list membership
  only, never execution eligibility, risk approval, or broker availability.

Phase 0's catalogue only ever produces rows for a small, explicit seed list
(`BTC`, `ETH`, `SOL`) — deliberately **not** derived from `config.hermesAgent.instrumentUniverse`
(which may list equities with zero verified evidence). This guarantees the catalogue can never
silently expand scope just because the configured universe changes.

## CLI usage

```
npm run instrument:catalogue
npm run instrument:catalogue -- --json
```

Prints one row per seed symbol, the rejected-evidence count/reasons, generation timestamp, source
directory, and an explicit "no provider calls made" line. Never connects to a broker.

## Known limitation

Stage 4 (execution) evidence is not ingested by this phase at all — no Stage-4 evidence file
format/location exists yet. `stage4CapabilityStatus` is always `NOT_TESTED` today. Building that
ingestion (and any live-runtime wiring) is future work, not part of this foundation.
