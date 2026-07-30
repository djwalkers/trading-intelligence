import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";

// Legacy-worker UI cleanup — required test: "legacy controls remain accessible in developer/
// legacy settings" (navigation requirement: hide from primary nav, never delete the route).

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: vi.fn() }),
}));

const mockUseAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/auth-context", () => ({ useAuth: mockUseAuth }));

describe("Sidebar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the legacy paper-trading simulator routes under a distinct 'Developer / Legacy' group — never deleted, just relocated", () => {
    mockUseAuth.mockReturnValue({ isConfigured: false, user: null, signOut: vi.fn() });
    render(<Sidebar />);

    const legacyGroup = screen.getByTestId("sidebar-legacy-group");
    expect(within(legacyGroup).getByText("Developer / Legacy")).toBeInTheDocument();
    expect(within(legacyGroup).getByRole("link", { name: /paper portfolio/i })).toHaveAttribute("href", "/portfolio");
    expect(within(legacyGroup).getByRole("link", { name: /trade journal/i })).toHaveAttribute("href", "/trade-journal");
    expect(within(legacyGroup).getByRole("link", { name: /bot decisions/i })).toHaveAttribute("href", "/bot-decisions");
    expect(within(legacyGroup).getByRole("link", { name: /ai decision history/i })).toHaveAttribute(
      "href",
      "/decision-intelligence",
    );
  });

  it("keeps Dashboard, Trade Approval, and Operations Centre in the primary group, not the legacy one", () => {
    mockUseAuth.mockReturnValue({ isConfigured: false, user: null, signOut: vi.fn() });
    render(<Sidebar />);

    const legacyGroup = screen.getByTestId("sidebar-legacy-group");
    expect(within(legacyGroup).queryByRole("link", { name: /trade approval/i })).not.toBeInTheDocument();
    expect(within(legacyGroup).queryByRole("link", { name: /^dashboard$/i })).not.toBeInTheDocument();
    expect(within(legacyGroup).queryByRole("link", { name: /operations centre/i })).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: /trade approval/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^dashboard$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /operations centre/i })).toBeInTheDocument();
  });
});
