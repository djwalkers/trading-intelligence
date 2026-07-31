# eToro Stage-4 Capability Evidence

**Status:** Formal evidence contract + catalogue ingestion. Stage 4 itself is unchanged behaviourally
(same resolve → quote → open → confirm → close → confirm sequence, same demo-only guards, same
cleanup semantics) — this phase adds a durable, immutable evidence document per run and teaches the
Phase 0 instrument catalogue to ingest it. **No Stage 4 run was executed to build this feature.**

## ⚠️ Safety warning

`npm run broker:etoro-smoke` **opens and closes one real eToro DEMO position** every time it is run.
It never reaches a live route (fixed to `etoro-demo`, `ETORO_ENV` must be `"demo"`), but it does
genuinely mutate demo broker state. It remains the *only* file in this codebase permitted to call
`placeMarketOrder`/`closePosition` — the catalogue, the evidence loader, and every type/validation
helper in `stage4-capability-evidence.ts` are filesystem-only, read-only, and have no broker,
execution, approval, lifecycle, or risk dependency whatsoever.

## Purpose

Gives Stage 4 the same evidence discipline the read-only probe already has: one immutable,
self-contained JSON document per run, written once, never appended to or overwritten, ingestible by
the instrument catalogue as first-class `stage4CapabilityStatus` provenance — replacing "we ran it
once and it seemed fine" with "here is the exact, timestamped, redacted proof."

## Evidence directory

- `.data/hermes-execution/etoro-stage4-capability-evidence/` — one file per run+instrument, named
  `<runId>__<requestedInstrument>.json`.
- Local, immutable, and **gitignored** (`.data/` is excluded repo-wide) — never committed, never
  shared as-is between machines; each environment accumulates its own history.
- The filename is informational only — ingestion never trusts it; every fact comes from the
  document's own fields (`runId`, `requestedInstrument`, etc.).

## Evidence schema (`Stage4EvidenceDocument`, schemaVersion 1, evidenceType `ETORO_STAGE4_CAPABILITY`)

A dedicated, independent schema — never the read-only probe's shape. Top-level fields:

`schemaVersion`, `evidenceType`, `runId`, `startedAt`, `completedAt`, `gitCommit`, `appVersion`,
`brokerProvider`, `requestedInstrument`, `resolvedInstrument` (null until resolution succeeds; then
`{ symbol, displayName, brokerInstrumentId, instrumentTypeID, exchangeID }`), `accountModeEvidence`,
`stages`, `finalClassification`, `classificationReasons`, `limitations`, `evidenceGeneratedAt`.

`stages` has exactly six keys — `resolution`, `quote`, `openOrderSubmission`,
`openPositionConfirmation`, `closeOrderSubmission`, `closedPositionConfirmation` — each a
`{ status, detail, elapsedMs?, attempts? }` plus a few stage-specific safe identifiers (e.g.
`brokerPositionId`, `brokerOrderId`, `requestedNotional`, `bid`/`ask`, `confirmedAt`). `status` is
one of `NOT_RUN | SUCCEEDED | FAILED | INDETERMINATE`.

**Never persisted, anywhere in the document:** access tokens, cookies, authorization headers,
environment dumps, full raw provider payloads, unrelated portfolio/account data, personal data. Every
string field is passed through recursive redaction (`redactDeep`/`redactSecrets`, matching the
read-only probe's own convention) before the document is ever written to disk.

## Account-mode proof (no broker-confirmed `accountMode` field exists)

Neither eToro's search, rates, nor order-execution responses return anything resembling an
`accountMode` field (same limitation already documented for the read-only probe's `ProbeConfiguration`).
Stage 4 does not fabricate one. Instead `accountModeEvidence` records only facts this process can
actually prove about itself:

```json
{ "configuredProvider": "etoro-demo", "demoOnlyGuardPassed": true, "liveRouteReachable": false }
```

`demoOnlyGuardPassed` is true only once the tool's own pre-flight checks (`ETORO_ENV === "demo"`,
credentials present) have already passed. `liveRouteReachable` is always `false` — no eToro CLI tool
in this codebase ever constructs a live-route client, so there is nothing to prove beyond its own
absence.

## Final classification

Exactly three values — `VERIFIED | FAILED | INDETERMINATE` — decided once, by `classifyStage4()`
(`stage4-capability-evidence.ts`), the single source of truth both the writer and every test share.

**VERIFIED** requires ALL of: the demo-only guard confirmed, AND every one of the six stages
`SUCCEEDED` — unambiguous resolution, a valid quote, a successful open submission, the exact new
position confirmed open, a successful close submission, and that exact position confirmed absent
afterward.

**Ambiguity handling — the core safety rule:** if *any* stage's outcome is `INDETERMINATE` (an open/
close submission that timed out, an order response that couldn't be reconciled to exactly one
position, a confirmation step that found the position missing or still present when it shouldn't be),
the **entire run is INDETERMINATE**, even if another stage independently `FAILED`. An unresolved
ambiguity about whether broker state changed is never allowed to read as a clean `FAILED` (which
implies "nothing happened") or masked by an unrelated failure elsewhere. `EtoroTimeoutError` and
`EtoroReconciliationError`/`EtoroCleanupRequiredError` all map to `INDETERMINATE` for exactly this
reason; only a definitive server-side rejection (`EtoroApiError`, an explicit HTTP error response)
is trusted enough to call `FAILED`.

**FAILED** means a definitive capability failure with a safe, explicit reason (`classificationReasons`,
e.g. `RESOLUTION_FAILED`, `OPEN_ORDER_SUBMISSION_FAILED`) — never a mutation-adjacent stage with an
unknown outcome.

## Exit codes (`broker-etoro-smoke.ts`)

Named constants, never magic numbers:

| Code | Name | Meaning |
|---|---|---|
| 0 | `VERIFIED` | Full Stage-4 capability verified |
| 1 | `CONFIGURATION_FAILURE` | Demo-only guard / instrument / amount config invalid (no evidence written — nothing instrument-specific was ever reached) |
| 2 | `RESOLUTION_FAILURE` | Connect or instrument resolution failed |
| 3 | `QUOTE_FAILURE` | Quote retrieval failed |
| 4 | `OPEN_SUBMISSION_FAILURE` | Open order definitively rejected by eToro |
| 5 | `OPEN_CONFIRMATION_FAILURE` | Open position confirmation definitively failed |
| 6 | `CLOSE_SUBMISSION_FAILURE` | Close order definitively rejected by eToro |
| 7 | `CLOSE_CONFIRMATION_FAILURE` | Close confirmation definitively failed |
| 8 | `INDETERMINATE` | Broker state cannot be proven safely — see `classificationReasons` |
| 9 | `EVIDENCE_WRITE_FAILURE` | The broker operation(s) completed as described, but durable evidence was NOT written (e.g. an evidence file already exists for this runId) — console output always states the broker-side outcome first, never hidden behind this code |
| 10 | `UNEXPECTED_FAILURE` | An unanticipated exception, or an internal inconsistency this process cannot explain safely |

## Atomic, non-overwriting write

`writeStage4EvidenceFile()`: write to a unique temp file → `fsync` → `fs.link()` the temp file into
the final destination → remove the temp file. `fs.link()` fails with `EEXIST` if the destination
already exists — unlike a rename, it structurally cannot overwrite. An evidence file for a given
`runId`+instrument is therefore **never** silently replaced; a collision fails safely with
`EVIDENCE_WRITE_FAILURE`, and the pre-existing file is left byte-for-byte untouched. The in-memory
run record is created *before* the broker connection is even attempted, updated after each stage, and
the final document is written from a `finally` block — an evidence document is always **attempted**,
even on a mid-run crash or an early per-stage failure.

## Catalogue precedence (Stage-4 evidence)

Mirrors the read-only loader's own rules exactly, applied independently:

1. Loaded from its own dedicated directory (`loadStage4CapabilityEvidence`), never mixed with
   read-only evidence files.
2. Schema version, `evidenceType`, provider, demo-only proof, requested/resolved symbol agreement,
   and `startedAt <= completedAt` are all validated; malformed evidence is rejected with an explicit
   reason, never guessed.
3. A `completedAt` more than `FUTURE_TIMESTAMP_TOLERANCE_MS` (5 minutes — the same constant and
   tolerance the read-only loader uses) ahead of catalogue generation time is rejected.
4. Symlinks are rejected outright, never followed. A pointer/audit-log-style filename
   (`etoro-stage4-smoke-log.json`) is excluded by name before any parse attempt.
5. Duplicate `runId`s: byte-for-byte identical documents contribute once; conflicting duplicates are
   rejected (`CONFLICTING_DUPLICATE_RUN_ID`), never silently tie-broken.
6. Per instrument, accepted records are sorted by `(completedAt, runId)`; the **chronologically
   latest** one is authoritative for `stage4CapabilityStatus`/provenance/history. A newer `FAILED` or
   `INDETERMINATE` run **always supersedes** an older `VERIFIED` one — the most favourable result is
   never preserved.

## Catalogue provenance fields

Kept entirely separate from the read-only fields: `stage4CapabilityStatus`, `stage4LastTestedAt`,
`stage4EvidenceRunId`, `stage4EvidenceGitCommit`, `stage4EvidenceFile`,
`stage4ClassificationReasons`, `stage4History` (oldest first, same shape convention as the read-only
`history` array).

## Effective-status truth table

`computeEffectiveCapabilityStatus(readOnly, stage4)` — complete for all 16 combinations:

| readOnly \ stage4 | NOT_TESTED | VERIFIED | FAILED | INDETERMINATE |
|---|---|---|---|---|
| NOT_TESTED | NOT_TESTED | NOT_TESTED | FAILED | INDETERMINATE |
| UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | FAILED | INDETERMINATE |
| PARTIALLY_SUPPORTED | PARTIALLY_SUPPORTED | PARTIALLY_SUPPORTED | FAILED | INDETERMINATE |
| READ_ONLY_VERIFIED | READ_ONLY_VERIFIED | **VERIFIED** | FAILED | INDETERMINATE |

Rules this table encodes: `stage4 = FAILED` and `stage4 = INDETERMINATE` always dominate, regardless
of `readOnly` — a concrete broker-execution problem or an unresolved ambiguity is never hidden behind
a stale or unrelated read-only reading. `effective` can only ever become `VERIFIED` when `readOnly`
is itself `READ_ONLY_VERIFIED` **and** `stage4` is `VERIFIED` — an older Stage-4 `VERIFIED` result is
overridden the moment a newer read-only run degrades (never the reverse: read-only alone can never
produce `VERIFIED`).

## Safe operator workflow

1. Confirm `ETORO_ENV=demo`, `ETORO_API_KEY`/`ETORO_USER_KEY` set, `ETORO_DEMO_TEST_INSTRUMENT`
   points at one of the seeded symbols (BTC/ETH/SOL), `ETORO_DEMO_TEST_AMOUNT` is a small positive
   demo notional.
2. Run `npm run broker:etoro-smoke` — read the console warning; it WILL open and close one demo
   position.
3. Inspect the printed classification and exit code; the evidence file path is printed on success
   (and attempted even on failure).
4. Run `npm run instrument:catalogue` (or `-- --json`) to see the ingested Stage-4 state alongside
   read-only status and the combined effective status.
5. Never re-run against a `runId` that already has an evidence file — it will fail safely
   (`EVIDENCE_WRITE_FAILURE`) rather than overwrite; `runId` is time-based, so this only matters if
   you manually reuse one.
