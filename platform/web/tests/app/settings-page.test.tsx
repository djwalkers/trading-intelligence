import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Legacy-worker UI cleanup — required test: "legacy controls remain accessible in developer/
// legacy settings," with a clear non-Hermes disclaimer. Child panels are stubbed since their own
// behaviour is unchanged and out of scope here — this test is about page-level structure/copy.

vi.mock("@/components/settings/BrowserAutomationPanel", () => ({
  BrowserAutomationPanel: () => <div data-testid="browser-automation-panel" />,
}));
vi.mock("@/components/settings/ServerAutomationPanel", () => ({
  ServerAutomationPanel: () => <div data-testid="server-automation-panel" />,
}));
vi.mock("@/components/settings/LegacyScanTriggerControl", () => ({
  LegacyScanTriggerControl: () => <div data-testid="legacy-scan-trigger" />,
}));
vi.mock("@/components/settings/MarketDataSettingsPanel", () => ({
  MarketDataSettingsPanel: () => <div data-testid="market-data-panel" />,
}));
vi.mock("@/components/settings/BrokerSettingsPanel", () => ({
  BrokerSettingsPanel: () => <div data-testid="broker-panel" />,
}));

const { default: SettingsPage } = await import("@/app/settings/page");

describe("Settings page", () => {
  it("groups legacy scanning controls under a clearly-marked 'Legacy paper-trading simulator' section with a non-Hermes disclaimer", () => {
    render(<SettingsPage />);

    expect(screen.getByRole("heading", { name: /legacy paper-trading simulator/i })).toBeInTheDocument();
    expect(screen.getByText(/this simulator is not connected to hermes agent or etoro/i)).toBeInTheDocument();
    expect(screen.getByTestId("browser-automation-panel")).toBeInTheDocument();
    expect(screen.getByTestId("server-automation-panel")).toBeInTheDocument();
    expect(screen.getByTestId("legacy-scan-trigger")).toBeInTheDocument();
  });

  it("never claims the legacy simulator affects Hermes Agent, broker, risk, or approval behaviour", () => {
    render(<SettingsPage />);
    expect(screen.getByText(/no effect on hermes agent, broker execution, risk, or approval behaviour/i)).toBeInTheDocument();
  });
});
