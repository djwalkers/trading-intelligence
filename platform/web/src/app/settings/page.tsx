import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { BrowserAutomationPanel } from "@/components/settings/BrowserAutomationPanel";
import { ServerAutomationPanel } from "@/components/settings/ServerAutomationPanel";
import { MarketDataSettingsPanel } from "@/components/settings/MarketDataSettingsPanel";
import { BrokerSettingsPanel } from "@/components/settings/BrokerSettingsPanel";

export const metadata = {
  title: "Settings | Trading Intelligence Platform",
};

// Build 1.12.0 — every piece of operational configuration that used to live on the Dashboard now
// lives here instead, so the Dashboard can stay an information page. Nothing on this page changes
// what the AI Engine decides or how it manages risk — only when and how it's allowed to run.
export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Configure automatic scanning, market data connections, and (in future) your broker account."
      />

      <SectionPanel
        title="Automatic scanning"
        description="Two independent ways for the AI Engine to scan without you clicking a button — use either, both, or neither"
      >
        <div className="divide-y divide-base-700/60">
          <BrowserAutomationPanel />
          <ServerAutomationPanel />
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
        Automatic scanning never places a real order — every trade it opens is a paper trade only.
        Changing these settings changes when the AI Engine runs, not how it decides what to do.
      </InfoNote>
    </>
  );
}
