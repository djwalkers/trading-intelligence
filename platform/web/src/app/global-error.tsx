"use client";

import { useEffect, useState } from "react";
import { logger } from "@/lib/logger/logger";

interface GlobalErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

// Next.js's root-level error boundary — only fires when the root layout itself fails to render,
// which means Sidebar/Topbar/AppShell can't be trusted to still work. Must render its own
// <html>/<body> (this replaces the entire page, not just a segment) and stays deliberately
// minimal/inline-styled rather than depending on Tailwind utility classes resolving correctly,
// consistent with Next's own guidance for this specific boundary.
export default function GlobalErrorPage({ error, reset }: GlobalErrorPageProps) {
  const [referenceId, setReferenceId] = useState(() => error.digest ?? "");

  useEffect(() => {
    const id = error.digest ?? `client-${Math.random().toString(36).slice(2, 10)}`;
    logger.error("Unhandled application error (root boundary)", {
      component: "global-error-boundary",
      errorCode: "UNKNOWN_ERROR",
      referenceId: id,
      reason: error.message,
    });
    Promise.resolve().then(() => setReferenceId(id));
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#05070a",
          color: "#f4f6f8",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            padding: 32,
            borderRadius: 16,
            border: "1px solid #1c2230",
            backgroundColor: "#0b0e14",
          }}
        >
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>The application failed to load</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#98a2b3", marginTop: 12 }}>
            Nothing was changed, and no trading action was taken. Please try reloading the page.
          </p>
          <div
            style={{
              marginTop: 16,
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid rgba(232,163,61,0.3)",
              backgroundColor: "rgba(232,163,61,0.1)",
              color: "#e8a33d",
              fontSize: 12,
            }}
          >
            Reference: {referenceId}
          </div>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              padding: "10px 18px",
              borderRadius: 8,
              border: "1px solid rgba(62,207,158,0.3)",
              backgroundColor: "rgba(62,207,158,0.1)",
              color: "#3ecf9e",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
