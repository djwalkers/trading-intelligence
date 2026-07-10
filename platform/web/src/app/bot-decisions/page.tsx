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
        description="Every scan the AI Engine has made in this browser, and why."
      />

      <SectionPanel
        title="Scan history"
        description="Most recent first — timestamp, instruments scanned, selection, risk checks, outcome"
      >
        <BotDecisionsView />
      </SectionPanel>

      <InfoNote>
        Scans happen when you click &quot;Run scan now&quot; on the Dashboard, or automatically if
        you&apos;ve turned on automatic scanning in Settings. It is paper trading only; no real
        orders are placed. This log is stored in this browser only — it doesn&apos;t include scans
        made by always-on server-based scanning, which are recorded separately (see AI Decision
        History).
      </InfoNote>
    </>
  );
}
