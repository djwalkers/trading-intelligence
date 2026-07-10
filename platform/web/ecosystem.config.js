// Build 1.13.0 — PM2 process definitions for the two long-running processes this platform needs
// in production: the Next.js web server, and the separate VPS worker (Mission 8) that runs
// scheduled scans independently of any browser. Neither process previously had any process
// supervision config in this repo — see docs/operations/DEPLOYMENT.md for the full setup,
// including the one-time `npm run build` this assumes has already happened before `pm2 start`.
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
  ],
};
