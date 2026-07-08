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
        description="Every scan the Bot Runner has made in this browser, and why."
      />

      <SectionPanel
        title="Scan history"
        description="Most recent first — timestamp, instruments scanned, selection, risk checks, outcome"
      >
        <BotDecisionsView />
      </SectionPanel>

      <InfoNote>
        The Bot Runner only scans when you click &quot;Run Bot Scan&quot; on the Dashboard — there
        is no scheduled or autonomous triggering in this build. It is paper trading only; no real
        orders are placed. This log is stored in this browser only and is not scoped to any
        signed-in user or synced to Supabase.
      </InfoNote>
    </>
  );
}
