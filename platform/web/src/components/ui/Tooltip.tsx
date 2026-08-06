"use client";

import { useId, type ReactNode } from "react";

interface TooltipProps {
  content: ReactNode;
  /** Accessible name for the trigger button — read by screen readers before the tooltip content
   * itself (via aria-describedby below). */
  label: string;
}

/** A small, CSS-only info-icon tooltip — no JS state, revealed on hover or keyboard focus via
 * Tailwind's group-hover/group-focus-within. Used to move long, secondary explanatory copy out of
 * a card's always-visible text so the card itself stays visually light. */
export function Tooltip({ content, label }: TooltipProps) {
  const tooltipId = useId();

  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-base-700 text-[10px] leading-none text-ink-500 outline-none transition-colors hover:border-ink-400 hover:text-ink-300 focus-visible:border-ink-400 focus-visible:text-ink-300"
      >
        i
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full right-0 z-10 mb-2 w-64 rounded-lg border border-base-700 bg-base-900 px-3 py-2 text-xs leading-relaxed text-ink-300 opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
