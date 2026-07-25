// Build 1.13.0 — PM2 process definitions for the long-running processes this platform needs in
// production: the Next.js web server, the separate VPS worker (Mission 8) that runs scheduled
// scans independently of any browser, and (Prototype 1.0, Increment 1) the standalone Hermes
// execution runtime scheduler. None of these processes had any process supervision config in this
// repo until Build 1.13.0 — see docs/operations/DEPLOYMENT.md for the full setup, including the
// one-time `npm run build` this assumes has already happened before `pm2 start`.
module.exports = {
  apps: [
    {
      name: "trading-intelligence-web",
      cwd: __dirname,
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production",
      },
      max_restarts: 10,
      restart_delay: 5000,
      out_file: "./.pm2-logs/web-out.log",
      error_file: "./.pm2-logs/web-error.log",
    },
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
      // Prototype 1.0, Increment 1 (ROAD-TO-PROTOTYPE-1.0.md, P0 Gap 1). Supervises the standalone
      // `npm run market:runtime` scheduler process (src/hermes-execution/market-runtime.ts).
      // Deliberately `exec_mode: "fork"` (the same mode the two apps above already run in,
      // confirmed locally — setting `instances` without it made PM2 select cluster mode instead,
      // which restart-looped immediately and is wrong for an `npm`-wrapped script). Fork mode
      // always runs exactly one process for this app, with no scaling knob to misuse:
      // TradingRuntime's cycle-overlap protection (isCycleRunning) is an in-process lock only, and
      // this pipeline was never designed for more than one concurrent scheduler instance.
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
