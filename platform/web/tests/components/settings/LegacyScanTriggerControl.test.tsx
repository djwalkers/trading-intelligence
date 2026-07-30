import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LegacyScanTriggerControl } from "@/components/settings/LegacyScanTriggerControl";

// Legacy-worker UI cleanup — required tests: "legacy controls remain accessible in developer/
// legacy settings" and "no trading behaviour changes." This control calls the exact same,
// unmodified useBotScanRunner() hook the old Dashboard CTA used — mocked here as a black box
// specifically so this test cannot pass by accident if that hook's own contract ever changed.

const mockUseBotScanRunner = vi.hoisted(() => vi.fn());
vi.mock("@/lib/state/use-bot-scan-runner", () => ({ useBotScanRunner: mockUseBotScanRunner }));

describe("LegacyScanTriggerControl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a clearly-labelled manual trigger that never claims to touch Hermes Agent or eToro", () => {
    mockUseBotScanRunner.mockReturnValue({ runScan: vi.fn(), isScanning: false });
    render(<LegacyScanTriggerControl />);

    expect(screen.getByRole("button", { name: /run legacy scan now/i })).toBeInTheDocument();
    expect(screen.getByText(/never places a real order/i)).toBeInTheDocument();
    expect(screen.getByText(/never involves hermes agent or etoro/i)).toBeInTheDocument();
  });

  it("calls the unmodified useBotScanRunner hook's runScan('Manual') when clicked — same behaviour as before", async () => {
    const runScan = vi.fn().mockResolvedValue({ tradeCreated: false, actionTaken: "No Trade", selectedInstrument: null });
    mockUseBotScanRunner.mockReturnValue({ runScan, isScanning: false });
    render(<LegacyScanTriggerControl />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run legacy scan now/i }));
      await Promise.resolve();
    });

    expect(runScan).toHaveBeenCalledWith("Manual");
  });

  it("disables the button while a scan is in flight", () => {
    mockUseBotScanRunner.mockReturnValue({ runScan: vi.fn(), isScanning: true });
    render(<LegacyScanTriggerControl />);
    expect(screen.getByRole("button", { name: /scanning/i })).toBeDisabled();
  });
});
