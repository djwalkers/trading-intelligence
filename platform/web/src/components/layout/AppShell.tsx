import type { ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { PrototypeBanner } from "@/components/layout/PrototypeBanner";
import { PersistenceFallbackBanner } from "@/components/layout/PersistenceFallbackBanner";
import { Footer } from "@/components/layout/Footer";
import { ImportHistoryModal } from "@/components/trading/ImportHistoryModal";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-base-950">
      <PrototypeBanner />
      <PersistenceFallbackBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 px-4 py-5 md:px-6 md:py-6 lg:px-8 lg:py-8">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">{children}</div>
          </main>
          <Footer />
        </div>
      </div>
      <ImportHistoryModal />
    </div>
  );
}
