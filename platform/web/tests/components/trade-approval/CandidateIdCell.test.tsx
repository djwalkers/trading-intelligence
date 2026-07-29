import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CandidateIdCell } from "@/components/trade-approval/TradeApprovalView";

// Hardening pass — Trade Approval UI candidate ID. Focused unit tests against the extracted cell
// component, rather than the whole TradeApprovalView (which depends on the auth context and a real
// Supabase client/repository) — this is the actual new behaviour this task adds.

const CANDIDATE_ID = "c5b129d9-e573-4fbc-9d2b-1940ed4a841d";

describe("CandidateIdCell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a truncated id and the full id as a hover title", () => {
    render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
    expect(screen.getByText(`${CANDIDATE_ID.slice(0, 8)}…`)).toBeInTheDocument();
    expect(screen.getByTitle(CANDIDATE_ID)).toBeInTheDocument();
  });

  it("never truncates away information needed to identify the candidate uniquely — the full id is always present in the DOM via title", () => {
    render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
    const container = screen.getByTitle(CANDIDATE_ID);
    expect(container.getAttribute("title")).toBe(CANDIDATE_ID);
  });

  it("copies the FULL candidate id to the clipboard, not the truncated display value", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
    await user.click(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` }));

    expect(writeText).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it("shows 'Copied' feedback after a successful copy, then reverts", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
    await user.click(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` }));

    expect(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` })).toHaveTextContent("Copied");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` })).toHaveTextContent("Copy");
  });

  it("degrades gracefully (no crash, no error state) when the clipboard write is rejected", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard access denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
    await user.click(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` }));

    // No crash, and the button never gets stuck showing "Copied" for a failed copy.
    expect(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` })).toHaveTextContent("Copy");
  });

  it("never renders any other candidate's field or a credential-shaped value alongside the id", () => {
    render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/apiKey|secret|token|password/i);
  });

  // Remediation pass — finding H3: the full id must be readable without relying on hover (`title`
  // is unavailable on touch/mobile), via an explicit click/tap-to-expand toggle.
  describe("expand/collapse toggle (finding H3)", () => {
    it("reveals the full candidate id as visible text content on click, not just via title", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<CandidateIdCell candidateId={CANDIDATE_ID} />);

      expect(screen.queryByText(CANDIDATE_ID)).not.toBeInTheDocument();

      const toggle = screen.getByRole("button", { name: `Show full candidate ID ${CANDIDATE_ID}` });
      await user.click(toggle);

      expect(screen.getByText(CANDIDATE_ID)).toBeInTheDocument();
      expect(screen.queryByText(`${CANDIDATE_ID.slice(0, 8)}…`)).not.toBeInTheDocument();
    });

    it("collapses back to the truncated view on a second click", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<CandidateIdCell candidateId={CANDIDATE_ID} />);

      const toggle = screen.getByRole("button", { name: `Show full candidate ID ${CANDIDATE_ID}` });
      await user.click(toggle);
      await user.click(screen.getByRole("button", { name: `Collapse candidate ID ${CANDIDATE_ID}` }));

      expect(screen.getByText(`${CANDIDATE_ID.slice(0, 8)}…`)).toBeInTheDocument();
      expect(screen.queryByText(CANDIDATE_ID)).not.toBeInTheDocument();
    });

    it("is operable via keyboard alone (Tab + Enter), proving it is not a hover-only affordance", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<CandidateIdCell candidateId={CANDIDATE_ID} />);

      const toggle = screen.getByRole("button", { name: `Show full candidate ID ${CANDIDATE_ID}` });
      toggle.focus();
      expect(toggle).toHaveFocus();

      await user.keyboard("{Enter}");

      expect(screen.getByText(CANDIDATE_ID)).toBeInTheDocument();
    });

    it("exposes expand/collapse state via aria-expanded for assistive technology", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<CandidateIdCell candidateId={CANDIDATE_ID} />);

      const toggle = screen.getByRole("button", { name: `Show full candidate ID ${CANDIDATE_ID}` });
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      await user.click(toggle);

      const expandedToggle = screen.getByRole("button", { name: `Collapse candidate ID ${CANDIDATE_ID}` });
      expect(expandedToggle).toHaveAttribute("aria-expanded", "true");
    });

    it("keeps the copy button working independently of the expand toggle", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

      render(<CandidateIdCell candidateId={CANDIDATE_ID} />);
      await user.click(screen.getByRole("button", { name: `Show full candidate ID ${CANDIDATE_ID}` }));
      await user.click(screen.getByRole("button", { name: `Copy candidate ID ${CANDIDATE_ID}` }));

      expect(writeText).toHaveBeenCalledWith(CANDIDATE_ID);
      expect(screen.getByText(CANDIDATE_ID)).toBeInTheDocument();
    });
  });
});
