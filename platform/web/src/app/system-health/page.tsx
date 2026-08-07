import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { PlatformHealthOverview } from "@/components/system-health/PlatformHealthOverview";
import { HermesAgentStatusPanel } from "@/components/system-health/HermesAgentStatusPanel";
import { RuntimeProcessesPanel } from "@/components/system-health/RuntimeProcessesPanel";
import { DatabaseStatusPanel } from "@/components/system-health/DatabaseStatusPanel";
import { AuthStatusPanel } from "@/components/system-health/AuthStatusPanel";
import { MarketDataStatusPanel } from "@/components/system-health/MarketDataStatusPanel";
import { HistoricalDataStatusPanel } from "@/components/system-health/HistoricalDataStatusPanel";
import { StrategyEngineStatusPanel } from "@/components/system-health/StrategyEngineStatusPanel";
import { AIEngineActivityPanel } from "@/components/system-health/AIEngineActivityPanel";
import { VPSWorkerStatusPanel } from "@/components/system-health/VPSWorkerStatusPanel";
import { TradingModeStatusPanel } from "@/components/system-health/TradingModeStatusPanel";
import { HermesRegistryStatusPanel } from "@/components/system-health/HermesRegistryStatusPanel";
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
// changed.
//
// Legacy-worker UI cleanup. This page previously had no panel for the real Hermes Agent/eToro
// pipeline at all, and closed with a stale, factually false claim ("no broker connection, no live
// execution") directly contradicted by that real connection — see
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md. The real Hermes Agent/eToro status now has its
// own prominent panel immediately below the platform health verdict; every panel describing the
// legacy Strategy Simulator/paper-trading system is grouped together afterwards and clearly
// marked "(Developer)", so the two can never be mistaken for one another.
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
        title="Hermes Agent & eToro Broker"
        description="Three distinct, real statuses — the official Hermes Agent, the trading runtime process, and the eToro broker connection. A running runtime does not by itself confirm Hermes Agent is healthy."
      >
        <HermesAgentStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Runtime Processes"
        description="Is the operating-system process alive, monitored via PM2 — separate from whether the Hermes trading runtime itself is completing cycles"
      >
        <RuntimeProcessesPanel />
      </SectionPanel>

      <SectionPanel
        title="Market Data"
        description="Where instrument prices and historical data currently come from"
      >
        <div className="divide-y divide-base-700/60">
          <MarketDataStatusPanel />
          <HistoricalDataStatusPanel />
        </div>
      </SectionPanel>

      <SectionPanel title="Database" description="Where your data is stored and how accounts are scoped">
        <div className="divide-y divide-base-700/60">
          <DatabaseStatusPanel />
          <AuthStatusPanel />
        </div>
      </SectionPanel>

      <SectionPanel
        title="Hermes Strategy Registry"
        description="The isolated execution pipeline that will trade whatever Hermes Lab's research programme certifies as eligible — see docs/execution-mvp-phase-1.md"
      >
        <HermesRegistryStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Legacy Strategy Simulator (Developer)"
        description="Deterministic rule-based calculations and recent scans — not connected to Hermes Agent or eToro"
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
        title="Always-On Scanning (Developer)"
        description="The legacy simulator's own background service — configured in Settings, never Hermes Agent"
      >
        <VPSWorkerStatusPanel />
      </SectionPanel>

      <SectionPanel title="Trading Mode (Developer)" description="What kind of orders the legacy simulator can place">
        <TradingModeStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Legacy Decision History (Developer)"
        description="Long-term record of every candidate the legacy Strategy Simulator has evaluated"
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
        The Hermes Agent/eToro pipeline above trades on a real demo broker connection — no real
        money is at risk (eToro demo accounts use virtual funds only), and no live (real-money)
        trading is enabled. The Legacy Strategy Simulator sections below are a separate, browser/
        local paper-trading system with no connection to Hermes Agent or eToro at all.
        &quot;Not enabled&quot; or &quot;Not available yet&quot; above describe features planned
        for a future release, not something broken today.
      </InfoNote>
    </>
  );
}
