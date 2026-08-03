# Historical Dataset Intake — Phase 4

**Status:** Offline, read-only-of-the-live-system dataset conversion workflow. Converts an
EXTERNALLY OBTAINED, ALREADY-LOCAL candle file (CSV or JSON) into the exact Phase 2
`CandleDatasetDocument` schema, validates it strictly through Phase 2's own validator, and generates
Phase 3-compatible manifest entries. No provider/broker call, no PM2 action, no live runtime
integration, no strategy promotion. This phase never fetches anything — it only ever reads a file the
caller already has on disk.

## Files

- `src/lib/hermes-execution/dataset-intake/dataset-intake.ts` — pure conversion/validation/slicing.
- `src/lib/hermes-execution/dataset-intake/manifest-writer.ts` — atomic manifest append/merge.
- `src/hermes-execution/dataset-prepare-cli.ts` — the `npm run dataset:prepare` entrypoint.
- `src/lib/hermes-execution/strategy-research/research-engine.ts` — gained a `--validate-only` code
  path (`validateResearchPlanDatasets`), factored out of `runResearch`'s own verification prefix.
- Tests: `tests/hermes-execution/dataset-intake/*.test.ts`, `tests/hermes-execution/dataset-prepare-cli.test.ts`.

Nothing in this phase is imported by, or imports, `runtime/trading-runtime.ts`, any broker adapter,
`market-data-provider.ts`, `trade-lifecycle/`, `trade-approval/`, `portfolio-risk-engine.ts`, or
`telegram/`.

## Accepted input formats

CSV and JSON only — a deliberately small set. JSON must be a top-level array of row objects; CSV must
have exactly one header row. The CSV parser correctly handles a double-quoted field containing commas
and the standard `""` escape for a literal quote inside a quoted field; it does NOT support a quoted
field spanning multiple physical lines (an embedded literal newline inside quotes).

## Required columns

Recognised by name (case-insensitive, trimmed), not by position. Two headers that normalise to the
SAME logical column (e.g. `Timestamp` and `timestamp`, or `Open` and `OPEN`) are rejected outright
(`AMBIGUOUS_INPUT_COLUMN`) — never silently collapsed to whichever one happened to be seen last:

- Exactly one of `timestamp` / `time` / `datetime` — more than one present is rejected as
  `AMBIGUOUS_TIMESTAMP_COLUMN`, never guessed.
- `open`, `high`, `low`, `close` — all required.
- `volume` — optional, matching Phase 2's own `DatasetCandle.volume?` field exactly.
- `instrument` / `symbol` — optional; if present, every row's value must equal the declared
  `--instrument` or the whole file is rejected (`MIXED_INSTRUMENT`).

Any other column is discarded at the input-adapter level only — reported as a warning, never carried
into the final validated dataset.

## Timezone rules

`--timezone` must be exactly `UTC` or a fixed offset like `+02:00`/`-05:00`, bounded to the real-world
range of -12:00 to +14:00 (an offset like `+25:00` is rejected as nonsensical, not merely "unusual") —
named zones (e.g. `America/New_York`) are unsupported (no timezone database, no DST handling). The
assumption is applied ONLY to a timestamp with no explicit offset/`Z`; a timestamp that already
carries its own explicit offset is parsed as-is, regardless of `--timezone`, and two timestamps
representing the same instant via different explicit offsets always normalise to the identical
canonical UTC output. A bare numeric epoch timestamp (seconds or milliseconds) is never supported —
that ambiguity is deliberately not resolved by guessing. An impossible calendar date (e.g.
"2026-02-30", which native `Date.parse` would otherwise silently roll over into March) is rejected
outright, never silently renormalised. `--date-from`/`--date-to` are parsed through this exact same
timezone-aware logic (never raw `Date.parse`, which for a naive date-time string would otherwise
silently fall back to the host machine's own local timezone).

## Validation rules

Column-name and timezone concerns are handled by this phase's own adapter. Every other correctness
rule — duplicate timestamps, out-of-order timestamps, gaps not exactly matching the declared
timeframe, non-finite/zero/negative OHLC, impossible OHLC ordering, unsupported timeframe, row/candle
count limits — is delegated to Phase 2's own `validateCandleDataset` (never re-implemented in
parallel). A row that fails to parse at all (malformed number, unparseable timestamp, wrong CSV field
count) is recorded as an invalid row; **any** invalid row rejects the whole import — no row is ever
silently dropped or repaired.

## No-gap/no-fill policy

This phase never interpolates, forward-fills, or fabricates a missing candle. A gap in the source data
is a hard rejection (`GAP_DETECTED`), not something this tool works around.

## Output schema

Exactly Phase 2's `CandleDatasetDocument`: `{ schemaVersion, instrument, timeframe, source, candles }`.
Numeric values are preserved exactly as given — no rounding. Candle order is deterministic (the
input's own order — the source data is never re-sorted, only rejected if out of order).

## Hashing and provenance

`datasetHash` is Phase 2's own `computeDatasetHash` — unchanged, never re-derived. Provenance
(`DatasetIntakeProvenance`) additionally records: the input file's own basename (never an absolute
path), the declared source label and timezone assumption, an operational `importedAt` timestamp, the
converter version, an `inputFileHash` (SHA-256 of the raw input bytes, independent of the dataset's
own content hash), and row counts. `importedAt`, absolute paths, host information, and any output
directory are excluded from the dataset's own content identity — `computeDatasetHash` never sees them.

## Slicing semantics (IN_SAMPLE / OUT_OF_SAMPLE / FULL_HISTORY / STRESS_PERIOD)

`--date-from` is **inclusive**, `--date-to` is **exclusive** — a plain chronological filter over the
already-validated candle array, applied in the SAME order (no re-sort, no dedup — those are validator
concerns, already settled). Two slices declared with the same boundary value (one's `--date-to` equal
to the next's `--date-from`) are contiguous with no overlap and no candle counted twice. Every slice is
independently re-validated through `validateCandleDataset` — a slice with too few candles is rejected
(`SLICE_INVALID`), never fabricated. A slice's hash naturally differs from the full-history hash since
its content differs. No indicator or strategy module is imported by, or reachable from, this code path.
Producing multiple roles means running the CLI once per role/date-range against the same source input.

## Manifest generation

Reuses Phase 3's own `DatasetManifestEntry` type and its `validateDatasetManifestEntry`/
`checkNoDuplicateManifestEntries` functions directly. The on-disk manifest file is a flat JSON array —
copy/pasteable verbatim into a research plan's own `datasets` field. Appending is atomic (temp file +
`fs.rename`), always preceded by validating the existing file and checking for a duplicate
`(instrument, role)` pair; a conflict is rejected outright, never silently overwritten. Manifest
generation is restricted to Phase 3's currently-supported timeframe(s) — a dataset prepared at a
timeframe Phase 3 research plans don't yet support is still written, but a manifest entry for it is
refused (`UNSUPPORTED_TIMEFRAME_FOR_MANIFEST`), since `dataset-manifest.ts`'s own validator would
reject it anyway. `--output` and `--manifest-output` are rejected outright if they resolve to the
same path (they are different documents with different schemas).

**Known limitation — no file locking.** `appendManifestEntry` reads, validates, and merges before
writing, with no lock held across that window. Running two `dataset:prepare --manifest-output <same
file>` invocations concurrently against the SAME manifest can silently lose one of their entries
(last `fs.rename` wins) — the write itself never corrupts the file, but a concurrent update can still
be dropped. Run manifest-generating commands sequentially, one at a time, against a given manifest
file.

**Note on partial completion.** If `--output` and `--manifest-output` are both supplied and the
dataset writes successfully but the manifest step then fails (e.g. a duplicate entry), the dataset
file IS already on disk and is NOT rolled back — it remains valid, standalone evidence even though
its manifest registration didn't complete. The CLI's failure output always reports this via its own
`output` field so this is never ambiguous to the caller.

## CLI

```
npm run dataset:prepare -- \
  --input <file> --format csv|json \
  --instrument BTC --timeframe 1h --source <label> --timezone UTC \
  --output <file>
```

Preview only, no filesystem write at all:

```
npm run dataset:prepare -- --input btc.csv --format csv --instrument BTC --timeframe 1h \
  --source "my export" --timezone UTC --dry-run --json
```

Produce an IN_SAMPLE slice and register it in a manifest:

```
npm run dataset:prepare -- --input btc.csv --format csv --instrument BTC --timeframe 1h \
  --source "my export" --timezone UTC --date-to 2025-10-01T00:00:00Z \
  --output btc-is.json --manifest-output manifest.json --role IN_SAMPLE
```

Then the matching OUT_OF_SAMPLE slice (contiguous, no overlap):

```
npm run dataset:prepare -- --input btc.csv --format csv --instrument BTC --timeframe 1h \
  --source "my export" --timezone UTC --date-from 2025-10-01T00:00:00Z \
  --output btc-oos.json --manifest-output manifest.json --role OUT_OF_SAMPLE
```

`--json` prints one JSON object on stdout for success, validation rejection, and an unexpected crash
alike. Exit codes: **0** success, **1** an explicit, expected rejection (bad arguments, validation
failure, output path already exists, manifest conflict), **2** an unexpected crash. Output files are
create-only (atomic `fs.link`) — Phase 4 has no `--overwrite`; an existing `--output` path is rejected,
never silently overwritten.

### Validating a research plan without running it

`strategy-research-cli.ts` gained `--validate-only`: verifies the plan schema, the strategy content
hash, and every declared dataset's hash/instrument/timeframe/date-range — WITHOUT generating the
experiment matrix or running a single backtest. Reuses `runResearch`'s own verification prefix
(`loadAndVerifyPlanAndDatasets` in research-engine.ts), never a second, parallel check.

```
npm run strategy:research -- --plan <path> --validate-only --json
```

## First real research-run checklist

`strategies/research-plans/CRYPTO_EMA_TREND_V1_BASELINE_NEIGHBOURHOOD__1.0.0.json` remains
**non-runnable as committed** — no real BTC/ETH/SOL candle data exists anywhere in this repository, and
this phase does not fabricate any. To make it runnable:

1. Obtain real (or your own synthetic-but-honestly-labelled) local BTC/ETH/SOL 1h candle files.
2. For each instrument, run `npm run dataset:prepare` with the real `--instrument`/`--source`/
   `--timezone`, producing a validated `CandleDatasetDocument` and its real `datasetHash`.
3. Use `--manifest-output`/`--role FULL_HISTORY` (or `IN_SAMPLE`/`OUT_OF_SAMPLE` slices) to generate
   real manifest entries — never hand-write a hash.
4. Replace each placeholder entry in the plan's own `datasets` array (currently
   `datasetFile: "PLACEHOLDER — ..."`, `expectedDatasetHash: "00…0"`) with the generated entries.
5. Run `npm run strategy:research -- --plan <path> --validate-only` to confirm every dataset resolves
   and hashes match, BEFORE running the full plan.
6. Only then run `npm run strategy:research -- --plan <path>` for real evidence.

This checklist is intentionally NOT auto-applied — no hash or date range in the example plan was
invented or guessed by this phase; the plan stays honestly non-runnable until real data is supplied.

## Limitations

- No claim that any prepared dataset is complete, accurate, or authoritative for any exchange or
  venue — this tool only ever reports what its own mechanical checks proved.
- No forward/backward fill of missing candles is ever performed.
- Timezone handling is based solely on the caller's declared `--timezone` assumption for naive
  timestamps — never auto-detected.
- A bare numeric epoch timestamp is unsupported (seconds vs. milliseconds ambiguity).
- No automatic promotion: this phase has no `status`/`usableForDemo`-shaped field anywhere in its
  output, and nothing it produces is ever wired into any approval, execution, lifecycle, or live-
  trading path.

## Binance historical dataset acquisition (`dataset:binance-download`)

Operator-run download-and-assembly workflow that produces the first REAL BTC/ETH/SOL datasets for
CRYPTO_EMA_TREND_V1's research plan, from Binance's own official public archive. Files:
`src/lib/hermes-execution/dataset-intake/binance-archive.ts` (pure: URLs, month ranges, checksum
parsing, timestamp-unit detection, archive-shape validation), `binance-zip.ts` (pure: minimal
single-entry ZIP reader), `binance-downloader.ts` (the ONLY network I/O — plain `fetch`, no
credentials), and `src/hermes-execution/dataset-binance-download-cli.ts` (orchestrates both stages and
hands the assembled rows to Phase 4's own `prepareDataset` — never a second, parallel dataset
validator; the final `datasetHash` is always Phase 2's own `computeDatasetHash`, reached only via that
existing path).

### Official source convention

`https://data.binance.vision/data/spot/monthly/klines/<SYMBOL>/1h/<SYMBOL>-1h-YYYY-MM.zip` plus its
matching `.CHECKSUM` file — never an unofficial mirror; the base URL is one fixed constant. Every
archive's SHA-256 is verified against its freshly-downloaded `.CHECKSUM` file before extraction ever
runs; a mismatch is rejected outright and the bad bytes are never written to disk.

### Binance column mapping

Monthly kline CSVs have no header row and 12 columns; only the first six (open time, open, high, low,
close, volume) are consumed — every other column (close time, quote volume, trade count, taker
volumes, the trailing "ignore" column) is discarded at this adapter boundary, never carried forward.

### The 2025 timestamp-unit change

Binance represents `open time` in **milliseconds** for archives through 2024, and in **microseconds**
from 2025 onward. The unit is detected per archive, purely by numeric magnitude (millisecond-epoch
values for realistic dates are ~13 digits; microsecond-epoch values are ~16 digits) — never by the
month number itself, and never guessed for a value that doesn't land cleanly in one of those two
ranges (a seconds-scale, nanoseconds-scale, or otherwise ambiguous value is rejected). Every row within
one archive must use the SAME unit as that archive's own first row — a unit change mid-file is
rejected (`MIXED_TIMESTAMP_UNITS`), never silently reinterpreted.

### Selected date ranges

- **IN_SAMPLE**: 2023-01-01T00:00:00Z (inclusive) to 2025-01-01T00:00:00Z (exclusive) — 731 days × 24h
  = 17,544 candles.
- **OUT_OF_SAMPLE**: 2025-01-01T00:00:00Z (inclusive) to 2026-01-01T00:00:00Z (exclusive) — 365 days ×
  24h = 8,760 candles.

2026 data is never acquired or assembled — enforced as a fixed constant independent of any CLI flag or
the host machine's current date.

### USDT-pair limitation

All three instruments are acquired as their Binance **spot, USDT-quoted** pair (`BTCUSDT`, `ETHUSDT`,
`SOLUSDT`). This is Binance spot market data only — never futures, never an exchange-independent
reference price — and results are specific to this venue and quote asset; they do not necessarily
generalise to any other pair, venue, or asset class.

### Commands

```
# List exactly which URLs would be requested — no network call, no filesystem write.
npm run dataset:binance-download -- --from 2023-01 --to 2025-12 --output-root .data/hermes-execution/research-datasets --dry-run --json

# Download, verify, and (once all 36 required months are cached) assemble + validate + write outputs.
npm run dataset:binance-download -- --from 2023-01 --to 2025-12 --output-root .data/hermes-execution/research-datasets
```

`--from`/`--to` control which months are DOWNLOADED in this invocation (useful for resuming a partial
run a few months at a time); the assembly stage always checks the full, fixed 2023-01..2025-12
requirement against whatever is verified in the local cache, from ANY prior invocation — so repeated,
incremental runs correctly converge once every required archive is present. Downloaded archives are
cached under `<output-root>/source/binance/`; a cached file is reused only if it still matches its own
freshly re-verified checksum, and is otherwise re-downloaded, never silently trusted.

Retries are bounded (3 attempts), timeouts are explicit (30s), and every request carries a fixed,
descriptive User-Agent — no credentials, no API key, no broker endpoint is ever contacted.

### Expected six outputs

Written to `<output-root>/prepared/`, each an exact Phase 2 `CandleDatasetDocument` that has passed
Phase 2's own validator: `BTC_IN_SAMPLE_1h.json`, `BTC_OUT_OF_SAMPLE_1h.json`, `ETH_IN_SAMPLE_1h.json`,
`ETH_OUT_OF_SAMPLE_1h.json`, `SOL_IN_SAMPLE_1h.json`, `SOL_OUT_OF_SAMPLE_1h.json` — `source` set to
`BINANCE_SPOT_<SYMBOL>` (e.g. `BINANCE_SPOT_BTCUSDT`). Output writes are atomic and create-only,
identical to `dataset:prepare`'s own convention — no `--overwrite` exists.

### Manifest and plan-placeholder replacement

A Phase 3-compatible manifest (all 6 entries, reusing `validateDatasetManifestEntry`/
`checkNoDuplicateManifestEntries` directly) is written to
`<output-root>/manifests/research-plan-manifest.json`, plus an `acquisition-report.json` (provider,
market, quote asset, symbols, archive months, source URLs/checksums, input byte hashes, detected
timestamp units, row counts, first/last timestamps, final dataset hashes, converter version,
generatedAt, warnings/limitations — including an explicit statement that successful validation never
establishes future profitability) and a `plan-placeholder-replacement.json` listing the exact
instrument/role/relative-path/hash values to copy into
`strategies/research-plans/CRYPTO_EMA_TREND_V1_BASELINE_NEIGHBOURHOOD__1.0.0.json`'s own `datasets`
array by hand. **The committed example plan is never edited automatically** — nothing this tool
produces is staged or committed by it, and everything it writes lives under the gitignored
`.data/` root.

### Known limitation

No cross-process file locking — see `manifest-writer.ts`'s own doc comment (shared with
`dataset:prepare`). Run one acquisition at a time against a given `--output-root`.
