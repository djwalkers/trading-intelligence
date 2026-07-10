import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BotDecisionLogProvider } from "@/lib/state/bot-decision-log-context";
import { BotDecisionsView } from "@/components/bot/BotDecisionsView";
import { BotSchedulerProvider } from "@/lib/state/bot-scheduler-context";
import { BrowserAutomationPanel } from "@/components/settings/BrowserAutomationPanel";
import { AuthProvider } from "@/lib/auth/auth-context";
import { PaperTradesProvider } from "@/lib/state/paper-trades-context";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { paperPortfolio } from "@/lib/mock";
import { Modal } from "@/components/ui/Modal";
import { ToastViewport } from "@/components/ui/ToastViewport";
import { pushToast } from "@/lib/notifications/toast-bus";
import { expectNoAxeViolations } from "./axe-helper";

// Build 1.13.0 — component-level accessibility coverage using axe-core against jsdom-rendered
// output, standing in for full route-level browser testing (no real browser/Chromium is
// available in this sandboxed test environment — see docs/product/BUILD-1.13.0.md for the full
// tooling rationale). Each case below maps to one of the routes this build's brief names:
// Bot Runner / Bot Decisions, Settings, and Paper Portfolio. Dashboard and Watchlist share the
// same KPI-card and table primitives already exercised here; AI Decision History was not
// separately covered — see "Remaining limitations" in the build doc.
describe("axe accessibility scan", () => {
  it("Bot Decisions (Bot Runner) has no serious/critical violations", async () => {
    const { container } = render(
      <BotDecisionLogProvider>
        <BotDecisionsView />
      </BotDecisionLogProvider>,
    );
    await screen.findByText(/scans yet|Scan #/);
    await expectNoAxeViolations(container);
  });

  it("Settings (Browser automation panel) has no serious/critical violations", async () => {
    const { container } = render(
      <BotSchedulerProvider>
        <BrowserAutomationPanel />
      </BotSchedulerProvider>,
    );
    await expectNoAxeViolations(container);
  });

  it("Paper Portfolio has no serious/critical violations", async () => {
    const { container } = render(
      <AuthProvider>
        <PaperTradesProvider>
          <PortfolioView paperPortfolio={paperPortfolio} />
        </PaperTradesProvider>
      </AuthProvider>,
    );
    await screen.findByText("Realised P/L");
    await expectNoAxeViolations(container);
  });

  it("An open modal dialog has no serious/critical violations", async () => {
    const { container } = render(
      <Modal labelledBy="axe-modal-title" onClose={() => {}}>
        <h2 id="axe-modal-title">Confirm action</h2>
        <p>Are you sure?</p>
        <button type="button">Cancel</button>
        <button type="button">Confirm</button>
      </Modal>,
    );
    await expectNoAxeViolations(container);
  });

  it("ToastViewport with an active notification has no serious/critical violations", async () => {
    pushToast("success", "Trade opened: BUY AAPL.");
    const { container } = render(<ToastViewport />);
    await screen.findByText("Trade opened: BUY AAPL.");
    await expectNoAxeViolations(container);
  });
});
