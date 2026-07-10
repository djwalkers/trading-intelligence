// Build 1.13.0 — test-only stub for the `server-only` package. The real package throws
// immediately when imported outside Next.js's "react-server" build condition, which Vitest (a
// plain Node/Vite process) never sets — aliased here to a no-op so server-only modules
// (server-config.ts, get-application-health.ts) can be unit tested directly, the same way
// Next.js's own "react-server" condition resolves this package to a no-op internally.
export {};
