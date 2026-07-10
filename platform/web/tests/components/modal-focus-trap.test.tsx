import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@/components/ui/Modal";

function TestModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal labelledBy="test-modal-title" onClose={onClose}>
      <h2 id="test-modal-title">Test modal</h2>
      <button type="button">First</button>
      <button type="button">Second</button>
    </Modal>
  );
}

describe("Modal focus trap", () => {
  it("moves focus into the dialog and traps Tab within it", async () => {
    const user = userEvent.setup();
    render(<TestModal onClose={() => {}} />);

    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });

    expect(first).toHaveFocus();

    await user.tab();
    expect(second).toHaveFocus();

    // Wraps back to the first control rather than escaping the dialog.
    await user.tab();
    expect(first).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger element", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {open ? (
            <Modal
              labelledBy="test-modal-title-2"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            >
              <h2 id="test-modal-title-2">Test modal</h2>
              <button type="button">Confirm</button>
            </Modal>
          ) : null}
        </div>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);

    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
});
