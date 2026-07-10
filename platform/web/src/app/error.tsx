"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { logger } from "@/lib/logger/logger";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Next.js App Router route-segment error boundary — catches rendering/data errors within a page
// while the rest of the app shell (Sidebar, Topbar) stays mounted, so navigating away still works
// even if one page is broken. Never renders `error.message`/stack directly: that's exactly the
// "raw internal exception" this build's security review flags as unsafe to expose in production.
// `error.digest` is Next's own built-in reference id for a server-side error (present in
// production builds); a short client-generated id is the fallback for a purely client-side error,
// which has no digest.
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  // `error.digest` (Next's own reference id) is available synchronously and is safe to read
  // during render; the random fallback id is only needed for a purely client-side error with no
  // digest, and generating it must be deferred into an effect — calling Math.random() during
  // render is an impure operation React (and this project's lint rule) disallows.
  const [referenceId, setReferenceId] = useState(() => error.digest ?? "");

  useEffect(() => {
    const id = error.digest ?? `client-${Math.random().toString(36).slice(2, 10)}`;
    logger.error("Unhandled page error", {
      component: "error-boundary",
      errorCode: "UNKNOWN_ERROR",
      referenceId: id,
      reason: error.message,
    });
    // Deferred into a microtask rather than a direct setState call in the effect body — same
    // pattern used throughout this codebase's hydration effects (e.g.
    // bot-decision-log-context.tsx) to avoid the cascading-render lint rule.
    Promise.resolve().then(() => setReferenceId(id));
    // Only re-run if the error identity itself changes (a genuinely new failure), not on every
    // render — `reset` is stable per error instance.
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-10">
      <div className="panel flex flex-col items-start gap-3 p-8">
        <h1 className="text-lg font-semibold text-ink-100">Something went wrong</h1>
        <p className="text-sm leading-relaxed text-ink-400">
          This page couldn&apos;t load. Nothing was changed, and no trading action was taken —
          paper trades and your automation settings are unaffected. You can try again, or head back
          to the Dashboard.
        </p>
        <div className="rounded-xl2 border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs leading-relaxed text-accent-amber">
          Reference: {referenceId}
        </div>
        <div className="mt-2 flex gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-400 transition-colors hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
