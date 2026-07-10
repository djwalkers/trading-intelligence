import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { PlatformHealthOverview } from "@/components/system-health/PlatformHealthOverview";
import { DatabaseStatusPanel } from "@/components/system-health/DatabaseStatusPanel";
import { AuthStatusPanel } from "@/components/system-health/AuthStatusPanel";
import { MarketDataStatusPanel } from "@/components/system-health/MarketDataStatusPanel";
import { HistoricalDataStatusPanel } from "@/components/system-health/HistoricalDataStatusPanel";
import { StrategyEngineStatusPanel } from "@/components/system-health/StrategyEngineStatusPanel";
import { AIEngineActivityPanel } from "@/components/system-health/AIEngineActivityPanel";
import { VPSWorkerStatusPanel } from "@/components/system-health/VPSWorkerStatusPanel";
import { TradingModeStatusPanel } from "@/components/system-health/TradingModeStatusPanel";
import { AIDecisionHistoryStatusPanel } from "@/components/system-health/AIDecisionHistoryStatusPanel";
import { instruments } from "@/lib/mock";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { APP_VERSION } from "@/lib/version";

export const metadata = {
  title: "Operations Centre | Trading Intelligence Platform",
};

// Build 1.12.0 — rebuilt from a long technical checklist into an Operations Centre: one health
// verdict up top, then grouped panels instead of a flat list. Route kept at /system-health (an
// implementation detail, not user-facing) — only the page title, sidebar label, and content
// changed. Every status here reads live application state; nothing is a hardcoded "not connected"
// placeholder left over from an earlier build.
export default function SystemHealthPage() {
  const { scores: strategyScores, evaluationTimeMs } =
    getStrategyEngine().evaluateAllWithTiming(instruments);
  const strategiesLoaded = getStrategyEngine().strategyCount;

  return (
    <>
      <PageHeader
        title="Operations Centre"
        description="Is the platform healthy right now, grouped by system."
      />

      <PlatformHealthOverview />

      <SectionPanel
        title="Market Data"
        description="Where instrument prices and historical data currently come from"
      >
        <div className="divide-y divide-base-700/60">
          <MarketDataStatusPanel />
          <HistoricalDataStatusPanel />
        </div>
      </SectionPanel>

      <SectionPanel
        title="AI Engine"
        description="Strategy calculations, recent scans, and the two safety layers that protect your capital"
      >
        <div className="divide-y divide-base-700/60">
          <StrategyEngineStatusPanel
            strategiesLoaded={strategiesLoaded}
            instrumentsEvaluated={strategyScores.length}
            evaluationTimeMs={evaluationTimeMs}
          />
          <AIEngineActivityPanel />
        </div>
      </SectionPanel>

      <SectionPanel
        title="Always-On Scanning"
        description="Runs independently of any browser tab, so it keeps working even when you're not — configured in Settings"
      >
        <VPSWorkerStatusPanel />
      </SectionPanel>

      <SectionPanel title="Database" description="Where your data is stored and how accounts are scoped">
        <div className="divide-y divide-base-700/60">
          <DatabaseStatusPanel />
          <AuthStatusPanel />
        </div>
      </SectionPanel>

      <SectionPanel title="Trading Mode" description="What kind of orders this platform can place today">
        <TradingModeStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="AI Decision History"
        description="Long-term record of every candidate the AI Engine has evaluated"
      >
        <AIDecisionHistoryStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Diagnostics"
        description="Build identity and where deployment monitoring can check platform status"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <span className="text-sm text-ink-300">Build {APP_VERSION}</span>
          <span className="text-xs text-ink-500">
            This platform exposes a <code className="text-ink-300">/api/health</code> endpoint for
            external uptime monitoring — it reports application, persistence, and market data
            status, and never triggers a scan or trade.
          </span>
        </div>
      </SectionPanel>

      <InfoNote>
        This platform runs on simulated paper trading — no broker connection, no live execution.
        &quot;Not enabled&quot; or &quot;Not available yet&quot; above describe features planned
        for a future release, not something broken today.
      </InfoNote>
    </>
  );
}
