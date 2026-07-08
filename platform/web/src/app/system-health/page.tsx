import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { SystemHealthList } from "@/components/tables/SystemHealthList";
import { PersistenceStatusPanel } from "@/components/system-health/PersistenceStatusPanel";
import { MarketDataStatusPanel } from "@/components/system-health/MarketDataStatusPanel";
import { AuthStatusPanel } from "@/components/system-health/AuthStatusPanel";
import { StrategyEngineStatusPanel } from "@/components/system-health/StrategyEngineStatusPanel";
import { BotRunnerStatusPanel } from "@/components/system-health/BotRunnerStatusPanel";
import { marketStatus, systemServices, instruments } from "@/lib/mock";
import { Badge } from "@/components/ui/Badge";
import { DotIcon } from "@/components/icons";
import { getStrategyEngine } from "@/lib/strategy-engine";

export const metadata = {
  title: "System Health | Trading Intelligence Platform",
};

export default function SystemHealthPage() {
  const { scores: strategyScores, evaluationTimeMs } =
    getStrategyEngine().evaluateAllWithTiming(instruments);
  const strategiesLoaded = getStrategyEngine().strategyCount;

  return (
    <>
      <PageHeader
        title="System Health"
        description="Current status of each platform service, including Mission 1.1's Bot Runner."
      />

      <div className="panel flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2 text-sm">
          <DotIcon className={marketStatus.isOpen ? "text-accent-teal" : "text-ink-500"} />
          <span className="text-ink-100">{marketStatus.label}</span>
          <span className="text-ink-500">&middot; {marketStatus.nextEvent}</span>
        </div>
        <Badge className="border-accent-amber/30 bg-accent-amber/10 text-accent-amber">
          Build 1.3.0 · Mission 1.1
        </Badge>
      </div>

      <SectionPanel
        title="Authentication"
        description="Whether sign-in is required, who is signed in, and how paper trading data is scoped"
      >
        <AuthStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Persistence"
        description="Where paper trades are currently being read from and written to"
      >
        <PersistenceStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Market Data"
        description="Where instrument prices are currently being sourced from"
      >
        <MarketDataStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Strategy Engine"
        description="Status of the deterministic strategy evaluation engine"
      >
        <StrategyEngineStatusPanel
          strategiesLoaded={strategiesLoaded}
          instrumentsEvaluated={strategyScores.length}
          evaluationTimeMs={evaluationTimeMs}
        />
      </SectionPanel>

      <SectionPanel
        title="Bot Runner"
        description="Manually-triggered autonomous paper trading status"
      >
        <BotRunnerStatusPanel />
      </SectionPanel>

      <SectionPanel
        title="Services"
        description={`${systemServices.length} core services that make up the platform`}
      >
        <SystemHealthList services={systemServices} />
      </SectionPanel>

      <InfoNote>
        This build intentionally ships without a broker connection, a database, or live execution.
        Services marked &quot;Not Connected&quot; or &quot;Disabled&quot; are expected at this
        stage and will be enabled in later builds.
      </InfoNote>
    </>
  );
}
