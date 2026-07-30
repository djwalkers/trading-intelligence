import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VPSWorkerStatusPanel } from "@/components/system-health/VPSWorkerStatusPanel";

// Legacy-worker UI cleanup — required tests: "stopped/stale legacy states render honestly" and
// "a stale last-scan timestamp must not be presented as healthy activity" (see
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md §7's safety verdict). This panel is explicitly
// scoped to the legacy simulator's own background service — never Hermes Agent/eToro status.

const mockUseAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/auth-context", () => ({ useAuth: mockUseAuth }));

const mockUseServerSchedule = vi.hoisted(() => vi.fn());
vi.mock("@/lib/state/server-schedule-context", () => ({ useServerSchedule: mockUseServerSchedule }));

describe("VPSWorkerStatusPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders 'Running' when enabled and the next scan is not yet overdue", () => {
    mockUseAuth.mockReturnValue({ isConfigured: true });
    mockUseServerSchedule.mockReturnValue({
      isAvailable: true,
      schedule: {
        enabled: true,
        intervalMinutes: 30,
        nextScanAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        lastScanAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        lastStatus: "Success",
        lastError: null,
      },
    });

    render(<VPSWorkerStatusPanel />);
    expect(screen.getByTestId("legacy-worker-observed-state")).toHaveTextContent("Running");
  });

  it("renders 'Stopped' (never 'Running') when always-on scanning is disabled", () => {
    mockUseAuth.mockReturnValue({ isConfigured: true });
    mockUseServerSchedule.mockReturnValue({
      isAvailable: true,
      schedule: { enabled: false, intervalMinutes: 30, nextScanAt: null, lastScanAt: null, lastStatus: null, lastError: null },
    });

    render(<VPSWorkerStatusPanel />);
    expect(screen.getByTestId("legacy-worker-observed-state")).toHaveTextContent("Stopped");
  });

  it("renders 'Stale' (never presented as healthy activity) when enabled but far overdue", () => {
    mockUseAuth.mockReturnValue({ isConfigured: true });
    mockUseServerSchedule.mockReturnValue({
      isAvailable: true,
      schedule: {
        enabled: true,
        intervalMinutes: 30,
        // Overdue by 3 hours against a 30-minute interval — well past the 2x-interval grace window.
        nextScanAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        lastScanAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        lastStatus: "Success",
        lastError: null,
      },
    });

    render(<VPSWorkerStatusPanel />);
    const badge = screen.getByTestId("legacy-worker-observed-state");
    expect(badge).toHaveTextContent("Stale");
    expect(badge).not.toHaveTextContent("Running");
  });

  it("renders 'Unavailable' when the database isn't configured", () => {
    mockUseAuth.mockReturnValue({ isConfigured: false });
    mockUseServerSchedule.mockReturnValue({ isAvailable: false, schedule: null });

    render(<VPSWorkerStatusPanel />);
    expect(screen.getByTestId("legacy-worker-observed-state")).toHaveTextContent("Unavailable");
  });

  it("renders 'Unavailable' when not signed in / schedule unavailable, even if isConfigured is true", () => {
    mockUseAuth.mockReturnValue({ isConfigured: true });
    mockUseServerSchedule.mockReturnValue({ isAvailable: false, schedule: null });

    render(<VPSWorkerStatusPanel />);
    expect(screen.getByTestId("legacy-worker-observed-state")).toHaveTextContent("Unavailable");
  });

  it("labels this panel as the legacy simulator's own background service, never Hermes", () => {
    mockUseAuth.mockReturnValue({ isConfigured: true });
    mockUseServerSchedule.mockReturnValue({
      isAvailable: true,
      schedule: { enabled: true, intervalMinutes: 30, nextScanAt: new Date(Date.now() + 60_000).toISOString(), lastScanAt: null, lastStatus: null, lastError: null },
    });

    render(<VPSWorkerStatusPanel />);
    expect(screen.getByText(/legacy simulator/i)).toBeInTheDocument();
    expect(screen.queryByText(/Hermes Agent/i)).not.toBeInTheDocument();
  });
});
