"use client";

import { usePersistenceStatus } from "@/lib/state/use-persistence-status";

// Invisible in the normal case (Supabase not configured, or configured and working) — only
// appears once Supabase has actually failed and the app has fallen back to local storage, so it
// never changes what most users see.
export function PersistenceFallbackBanner() {
  const { fallbackReason } = usePersistenceStatus();

  if (!fallbackReason) return null;

  return (
    <div className="flex items-center justify-center border-b border-accent-amber/20 bg-accent-amber/10 px-4 py-1.5 text-center text-xs font-medium text-accent-amber">
      Persistence unavailable. Falling back to local storage.
    </div>
  );
}
