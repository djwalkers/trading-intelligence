import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import { AuthProvider } from "@/lib/auth/auth-context";
import { PaperTradesProvider } from "@/lib/state/paper-trades-context";
import { BotDecisionLogProvider } from "@/lib/state/bot-decision-log-context";
import { BotSchedulerProvider } from "@/lib/state/bot-scheduler-context";
import { DecisionHistoryProvider } from "@/lib/state/decision-history-context";
import { ServerScheduleProvider } from "@/lib/state/server-schedule-context";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trading Intelligence Platform",
  description: "A calm, evidence-driven prototype for monitoring signals and paper trading performance.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans">
        <AuthProvider>
          <PaperTradesProvider>
            <BotDecisionLogProvider>
              <DecisionHistoryProvider>
                <ServerScheduleProvider>
                  <BotSchedulerProvider>
                    <AppShell>{children}</AppShell>
                  </BotSchedulerProvider>
                </ServerScheduleProvider>
              </DecisionHistoryProvider>
            </BotDecisionLogProvider>
          </PaperTradesProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
