import type { ReactNode } from "react";

interface InfoNoteProps {
  children: ReactNode;
}

export function InfoNote({ children }: InfoNoteProps) {
  return (
    <div className="rounded-xl2 border border-base-700 bg-base-900/60 px-4 py-3 text-xs leading-relaxed text-ink-500">
      {children}
    </div>
  );
}
