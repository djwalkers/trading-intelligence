"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { PrototypeBanner } from "@/components/layout/PrototypeBanner";
import { PersistenceFallbackBanner } from "@/components/layout/PersistenceFallbackBanner";
import { Footer } from "@/components/layout/Footer";
import { ImportHistoryModal } from "@/components/trading/ImportHistoryModal";
import { AuthGate } from "@/components/layout/AuthGate";

const AUTH_ROUTES = new Set(["/sign-in", "/sign-up", "/forgot-password", "/reset-password"]);

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Sign-in/sign-up/forgot-password/reset-password render a minimal centered layout — no
  // sidebar, no persistence/import widgets that assume an authenticated app session — but keep
  // the same dark theme and the prototype banner.
  if (AUTH_ROUTES.has(pathname)) {
    return (
      <div className="flex min-h-screen flex-col bg-base-950">
        <PrototypeBanner />
        <main className="flex flex-1 items-center justify-center px-4 py-10">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-base-950">
      <PrototypeBanner />
      <PersistenceFallbackBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 px-4 py-5 md:px-6 md:py-6 lg:px-8 lg:py-8">
            <AuthGate>
              <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">{children}</div>
            </AuthGate>
          </main>
          <Footer />
        </div>
      </div>
      <ImportHistoryModal />
    </div>
  );
}
