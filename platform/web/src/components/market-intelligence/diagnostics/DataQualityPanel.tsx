import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/utils/format";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import { formatDuration } from "./diagnostics-format";

interface DataQualityPanelProps {
  data: MarketDiagnosticsResult;
}

function PassBadge({ passed, label }: { passed: boolean; label: string }) {
  return (
    <Badge
      className={
        passed
          ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
          : "border-accent-red/30 bg-accent-red/10 text-accent-red"
      }
    >
      {label}: {passed ? "passed" : "failed"}
    </Badge>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-sm text-ink-400">{label}</span>
      <span className="text-sm text-ink-200">{value}</span>
    </div>
  );
}

// Phase 2A.1 — Internal Market Diagnostics UI, section F. Every *Passed flag reads directly off
// MarketDiagnosticsResult.validation, which is always true here by construction (see that
// interface's own doc comment: a real violation means candle-validation.ts already rejected the
// fetch before a result could exist at all — this panel reports "this result already cleared every
// gate", not a live per-check score). Missing volume is reported as a fact, never as a failure —
// per this phase's own instruction not to imply otherwise.
export function DataQualityPanel({ data }: DataQualityPanelProps) {
  const { validation } = data;

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Data quality</h2>
          <p className="mt-0.5 text-xs text-ink-500">What candle-validation.ts already checked before this result existed</p>
        </div>
      </div>

      <div className="divide-y divide-base-700/60">
        <Row label="Requested candle count" value={data.requestedCandleCount} />
        <Row label="Received candle count" value={data.receivedCandleCount} />
        <Row label="First candle timestamp" value={formatDateTime(data.firstCandleTimestamp)} />
        <Row label="Last candle timestamp" value={formatDateTime(data.lastCandleTimestamp)} />
        <Row label="Latest candle age" value={formatDuration(validation.dataAgeSeconds)} />
        <Row
          label="Volume availability"
          value={
            <Badge
              className={
                validation.volumeAvailable
                  ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                  : "border-base-600 bg-base-800 text-ink-300"
              }
            >
              {validation.volumeAvailable ? "Available" : "Unavailable (not a validation failure)"}
            </Badge>
          }
        />
      </div>

      <div className="flex flex-wrap gap-2 border-t border-base-700 px-5 py-4">
        <PassBadge passed={validation.duplicateTimestampsPassed} label="Duplicate timestamps" />
        <PassBadge passed={validation.ohlcValidationPassed} label="OHLC validation" />
        <PassBadge passed={validation.staleDataValidationPassed} label="Stale-data validation" />
        <Badge
          className={
            validation.fallbackOccurred
              ? "border-accent-red/30 bg-accent-red/10 text-accent-red"
              : "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
          }
        >
          Fallback occurred: {String(validation.fallbackOccurred)}
        </Badge>
      </div>
    </div>
  );
}
