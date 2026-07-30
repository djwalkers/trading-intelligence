import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { BrowserAutomationPanel } from "@/components/settings/BrowserAutomationPanel";
import { ServerAutomationPanel } from "@/components/settings/ServerAutomationPanel";
import { LegacyScanTriggerControl } from "@/components/settings/LegacyScanTriggerControl";
import { MarketDataSettingsPanel } from "@/components/settings/MarketDataSettingsPanel";
import { BrokerSettingsPanel } from "@/components/settings/BrokerSettingsPanel";

export const metadata = {
  title: "Settings | Trading Intelligence Platform",
};

// Build 1.12.0 — every piece of operational configuration that used to live on the Dashboard now
// lives here instead, so the Dashboard can stay an information page.
//
// Legacy-worker UI cleanup. The "Automatic scanning" section below configures ONLY the legacy
// Strategy Simulator (browser + always-on server scanning, see
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md) — it has no effect whatsoever on the Hermes
// Agent/eToro runtime, which is configured entirely by server environment variables and has no
// on/off switch here. This section is clearly marked as the legacy simulator so its enabled state
// can never be mistaken for Hermes runtime status.
export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Configure the legacy paper-trading simulator, market data connections, and (in future) your broker account."
      />

      <SectionPanel
        title="Legacy paper-trading simulator (Developer)"
        description="Two independent ways to run the legacy Strategy Simulator without clicking a button — use either, both, or neither"
      >
        <div className="px-5 pt-4">
          <InfoNote>This simulator is not connected to Hermes Agent or eToro.</InfoNote>
        </div>
        <div className="divide-y divide-base-700/60">
          <BrowserAutomationPanel />
          <ServerAutomationPanel />
          <LegacyScanTriggerControl />
        </div>
      </SectionPanel>

      <SectionPanel
        title="Market data"
        description="Where instrument prices and historical data currently come from"
      >
        <MarketDataSettingsPanel />
      </SectionPanel>

      <SectionPanel title="Broker connection" description="Live trading account setup">
        <BrokerSettingsPanel />
      </SectionPanel>

      <InfoNote>
        The legacy simulator never places a real order — every trade it opens is a paper trade
        only, entirely separate from the real Hermes Agent/eToro account shown on the Dashboard.
        Changing these settings changes when the legacy simulator runs, not how it decides what to
        do, and has no effect on Hermes Agent, broker execution, risk, or approval behaviour.
      </InfoNote>
    </>
  );
}
