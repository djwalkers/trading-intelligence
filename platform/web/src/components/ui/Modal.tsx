"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  onClose?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

// Shared focus-management shell for every modal in the app (Build 1.12.2), replacing three
// near-identical hand-rolled implementations (PaperTradeModal, CloseTradeModal,
// ImportHistoryModal). Every modal in this codebase is conditionally *mounted* only while open
// (never kept in the DOM and CSS-hidden), so "mounted" and "open" are the same event — a plain
// mount effect covers focus-in, tab-trapping, escape-to-close, background scroll lock, and
// return-focus-on-close in one place, rather than duplicating this logic per modal.
export function Modal({
  role = "dialog",
  labelledBy,
  describedBy,
  onClose,
  initialFocusRef,
  className,
  children,
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Read via ref inside the mount-only effect below rather than depending on it directly — onClose
  // is typically a fresh inline closure on every parent render, and re-running the effect on every
  // such render would re-steal focus back to the initial control on each keystroke elsewhere.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const initialCandidate = initialFocusRef?.current;
    // A caller's preferred initial-focus target (e.g. a Confirm button) may be disabled at mount
    // time (price/quantity still loading) — disabled elements silently refuse focus, so fall back
    // to the first genuinely focusable control instead of leaving focus nowhere.
    const initialIsUsable = initialCandidate != null && !initialCandidate.matches(":disabled");
    const focusTarget =
      (initialIsUsable ? initialCandidate : null) ??
      container?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      container;
    focusTarget?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !container) return;

      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      } else if (!container.contains(document.activeElement)) {
        // Focus somehow ended up outside the dialog — pull it back in rather than letting the
        // background page keep it.
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={
        className ?? "fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 focus:outline-none"
      }
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {children}
    </div>
  );
}
