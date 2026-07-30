import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { BotDecisionsView } from "@/components/bot/BotDecisionsView";

export const metadata = {
  title: "Bot Decisions | Trading Intelligence Platform",
};

export default function BotDecisionsPage() {
  return (
    <>
      <PageHeader
        title="Bot Decisions"
        description="Every scan the legacy Strategy Simulator has made in this browser, and why. Not connected to Hermes Agent or eToro."
      />

      <SectionPanel
        title="Scan history"
        description="Most recent first — timestamp, instruments scanned, selection, risk checks, outcome"
      >
        <BotDecisionsView />
      </SectionPanel>

      <InfoNote>
        Scans happen when you click &quot;Run legacy scan now&quot; in Settings, or automatically
        if you&apos;ve turned on automatic scanning there. It is paper trading only; no real
        orders are placed. This log is stored in this browser only — it doesn&apos;t include scans
        made by always-on server-based scanning, which are recorded separately (see AI Decision
        History).
      </InfoNote>
    </>
  );
}
