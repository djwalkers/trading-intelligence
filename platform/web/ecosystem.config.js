// Build 1.13.0 — PM2 process definitions for the long-running VPS runtime processes.
//
// The Next.js frontend is hosted separately on Vercel and must not be started on the VPS.
//
// VPS responsibilities:
// - Scheduled worker
// - Standalone Hermes market runtime
//
// See docs/operations/DEPLOYMENT.md for the full setup, including the one-time
// `npm run build` required before starting these processes with PM2.
module.exports = {
  apps: [
    {
      name: "trading-intelligence-worker",
      cwd: __dirname,
      script: "npm",
      args: "run worker",
      env: {
        NODE_ENV: "production",
      },
      max_restarts: 10,
      restart_delay: 5000,
      out_file: "./.pm2-logs/worker-out.log",
      error_file: "./.pm2-logs/worker-error.log",
    },
    {
      // Supervises the standalone Hermes execution scheduler.
      //
      // Fork mode intentionally guarantees one runtime process. The scheduler's
      // cycle-overlap protection is in-process only, so multiple instances must
      // not be started.
      name: "hermes-market-runtime",
      cwd: __dirname,
      script: "npm",
      args: "run market:runtime",
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      max_restarts: 10,
      restart_delay: 5000,
      out_file: "./.pm2-logs/hermes-market-runtime-out.log",
      error_file: "./.pm2-logs/hermes-market-runtime-error.log",
    },
  ],
};