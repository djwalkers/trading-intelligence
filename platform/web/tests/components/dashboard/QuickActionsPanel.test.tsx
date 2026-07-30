import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuickActionsPanel } from "@/components/dashboard/QuickActionsPanel";

// Legacy-worker UI cleanup — required test: "no primary dashboard CTA triggers the legacy
// scanner." This component no longer imports useBotScanRunner at all (see its own source) — this
// test proves the rendered output has no scan-triggering control, and was not replaced with a
// fake Hermes-labelled action either.
describe("QuickActionsPanel (Dashboard)", () => {
  it("renders no 'Run scan now' (or any scan-triggering) button", () => {
    render(<QuickActionsPanel />);
    expect(screen.queryByRole("button", { name: /run.*scan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/run scan now/i)).not.toBeInTheDocument();
  });

  it("does not introduce a fake Hermes-labelled action in place of the removed CTA", () => {
    render(<QuickActionsPanel />);
    expect(screen.queryByText(/hermes/i)).not.toBeInTheDocument();
  });

  it("still links to the legacy scan settings, paper portfolio, trade journal, and Operations Centre", () => {
    render(<QuickActionsPanel />);
    expect(screen.getByRole("link", { name: /legacy scan settings/i })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: /view paper portfolio/i })).toHaveAttribute("href", "/portfolio");
    expect(screen.getByRole("link", { name: /view trade journal/i })).toHaveAttribute("href", "/trade-journal");
    expect(screen.getByRole("link", { name: /open operations centre/i })).toHaveAttribute("href", "/system-health");
  });
});
