# Prototype V1 — Deployment Runbook (Existing VPS)

Exact steps to deploy the code already committed and pushed (`main`, currently `ac9e5a0` — "Add
eToro runtime reliability and Telegram control") to your existing Linux VPS. This assumes the VPS
already exists; nothing here provisions new infrastructure. Complements
[`docs/prototype-v1-vps-handoff.md`](./prototype-v1-vps-handoff.md) (architecture/boundary
rationale) — this document is the ordered, exact-command version for actually doing it.

Everything below is standard OS tooling already used elsewhere in this repo (Node, npm, git, PM2 —
see `docs/operations/DEPLOYMENT.md`) plus Hermes Agent's own official installer. No Docker, no new
installer, no REST API, no MCP server, and no persistence layer are introduced by this runbook —
the current committed code still uses in-memory trade lifecycle storage (see §13).

---

## 1. Prerequisites to check on the VPS

- **OS**: any current Linux distribution already running on your VPS — commands below assume a
  Debian/Ubuntu-family distro (`apt`) for OS-package steps; substitute your package manager
  (`dnf`, `yum`, `apk`, ...) if different. Nothing here requires a specific distro.
- **Node.js** — see §3 for the exact required version.
- **git** — `git --version` (install via your package manager if missing).
- **curl** — required by Hermes Agent's own installer (`curl --version`).
- **Outbound HTTPS** from the VPS to: `github.com` (clone/pull), `api.telegram.org` (both Telegram
  bots), `public-api.etoro.com` (eToro demo API), plus whatever endpoint your chosen AI
  provider/Hermes Portal uses. Confirm with e.g. `curl -sI https://api.telegram.org` and
  `curl -sI https://public-api.etoro.com`.
- **A dedicated non-root user to run these processes** (e.g. `deploy`) — not strictly required, but
  standard practice; do not run either process as `root`.
- **PM2**, if not already installed for the existing web app/worker on this VPS — `pm2 -v` to
  check; see §10.
- Disk/RAM: negligible — these are small Node processes, no database server, no browser.

## 2. Exact Git clone/pull steps

First-time checkout:

```bash
git clone https://github.com/djwalkers/trading-intelligence.git /opt/trading-intelligence
cd /opt/trading-intelligence/platform/web
```

Updating an existing checkout to the latest pushed commit:

```bash
cd /opt/trading-intelligence
git fetch origin
git checkout main
git pull --ff-only origin main
git log -1 --oneline   # confirm you're on ac9e5a0 or later
```

Everything else in this runbook is run from `/opt/trading-intelligence/platform/web` (substitute
your own checkout path).

## 3. Required Node.js version and installation

Next.js 16.2.10 requires **Node >= 20.9.0**; this repo has been developed and tested against **Node
20.x** (see `docs/operations/DEPLOYMENT.md`). Install via `nvm` (no root needed, recommended) or
your distro's package manager:

```bash
# Option A — nvm (recommended, per-user, no root)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node --version   # confirm v20.x

# Option B — NodeSource on Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 4. Dependency installation and build

```bash
cd /opt/trading-intelligence/platform/web
npm install
npm run build
```

Note: `npm run market:runtime` and `npm run market:decide` run directly via `tsx` against the
TypeScript source (they do not read `.next/`), so `npm run build` is **not** a strict runtime
dependency for either — but run it anyway as a deployment gate: it runs the full TypeScript check,
and a failed build here means something is wrong before you go further (also required if you ever
run the unrelated Next.js dashboard on this same VPS via `npm start`).

## 5. Redacted environment-variable template

Only the subset Prototype V1 needs (full reference: `.env.example` at the repo root). Never commit
real values.

```
# Strategy source — does not need to exist; a missing/empty registry with DEMO_EXECUTION_MODE=true
# safely falls back to the built-in demo fixture strategy (confirmed in registry-client.ts).
HERMES_STRATEGY_REGISTRY_PATH=/opt/trading-intelligence/strategy-registry
DEMO_EXECUTION_MODE=true

# Broker / mode — fixed for Prototype V1. Trading212/Hyperliquid/live-money remain unsupported;
# BROKER_PROVIDER=trading212-demo is rejected at startup regardless of this file.
BROKER_PROVIDER=etoro-demo
HERMES_RUNTIME_MODE=demo
ETORO_ENV=demo
ETORO_API_KEY=<redacted>
ETORO_USER_KEY=<redacted>
ETORO_DEMO_TEST_INSTRUMENT=BTC
ETORO_DEMO_TEST_AMOUNT=<CFD notional amount in USD — must be set explicitly, no default>

# Live market data (real bid/ask via the connected eToro broker itself)
HERMES_MARKET_DATA_PROVIDER=live

# Scheduler (continuous runtime only; market:decide ignores these)
HERMES_SCHEDULER_ENABLED=true
HERMES_SCHEDULER_INTERVAL_MS=60000
HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS=30000
ETORO_HTTP_TIMEOUT_MS=10000

# Trading Platform's own Telegram bot — separate from Hermes's own Telegram gateway (see §8).
HERMES_TELEGRAM_ENABLED=true
HERMES_TELEGRAM_BOT_TOKEN=<redacted — from @BotFather>
HERMES_TELEGRAM_ALLOWED_CHAT_ID=<redacted — your numeric chat id, from @userinfobot>
```

## 6. Where the environment file lives, and its permissions

`tsx --env-file-if-exists=.env.local` resolves relative to the process's working directory, so it
must be:

```
/opt/trading-intelligence/platform/web/.env.local
```

...and both `npm run market:runtime`/`npm run market:decide` must be invoked with that directory as
the working directory (already true if you `cd` there first, or if PM2's `cwd` is set there — see
§10). It's already git-ignored (`.env*.local`), so cloning/pulling never touches it.

```bash
touch /opt/trading-intelligence/platform/web/.env.local
chmod 600 /opt/trading-intelligence/platform/web/.env.local
chown deploy:deploy /opt/trading-intelligence/platform/web/.env.local   # the user running the process
```

`600` (owner read/write only) is the important part — this file holds the eToro API key/user key
and the Telegram bot token in cleartext.

## 7. Official Hermes Agent installation and setup

Installed entirely separately from this repo — different directory, different process, its own
install root (`~/.hermes/`). Per Hermes Agent's own README
(github.com/NousResearch/hermes-agent):

```bash
# Install (Linux/macOS/WSL2/Termux) — bundles its own Python 3.11, Node.js, ripgrep, ffmpeg
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# One-time interactive setup — model/provider selection
hermes setup
# ...or, to use the Nous Portal specifically:
hermes setup --portal

# Change/inspect the selected model later
hermes model
```

Configuration is written to `~/.hermes/config.yaml` (of the user account that ran `hermes setup`).
The README does not publish exact env-var names for AI-provider credentials — the interactive
wizard (`hermes setup`) is the documented path; if you need non-interactive/scripted config, check
`hermes config set <key> <value>` / `hermes config get <key>` and Hermes's own docs at
`hermes-agent.nousresearch.com/docs`, since this was not fully specified in the README as fetched
for this runbook.

## 8. Telegram setup — two separate bots, not one

**Hermes's own Telegram gateway** (how you converse with Hermes):

```bash
hermes gateway setup    # interactive — creates/attaches its own Telegram bot
hermes gateway start    # starts the gateway process
```

**The Trading Platform's own Telegram bot** (this repo's alerts + `/status /positions /trades /pnl
/pause /resume /run /help`) — a **separate bot token**, created independently via @BotFather, set
as `HERMES_TELEGRAM_BOT_TOKEN` in `.env.local` (§5/§6). Do not reuse Hermes's own gateway bot token
here — this repo's bot authorizes exactly one configured chat id and silently ignores everyone
else, which only works correctly if it's a distinct bot with its own token. Both bots can point at
the **same chat id** (your own Telegram account) — you'll simply have two bots in your Telegram
client, one for talking to Hermes, one for trading-platform alerts/commands. Get your numeric chat
id once (via @userinfobot) and reuse it for both `HERMES_TELEGRAM_ALLOWED_CHAT_ID` and whatever
Hermes's own gateway setup asks for.

## 9. Exact startup commands

```bash
cd /opt/trading-intelligence/platform/web

# Continuous trading runtime (long-running)
npm run market:runtime

# One-shot decision cycle (exits after one cycle)
npm run market:decide
```

```bash
# Hermes Agent (separate process/directory, from wherever it was installed)
hermes gateway start     # Telegram gateway, background/daemon per its own docs
hermes                   # interactive CLI session, foreground
```

See §10 for running `market:runtime` under process supervision instead of a bare foreground
terminal.

## 10. Simplest process supervision (PM2 — already used elsewhere in this repo)

This repo already uses PM2 for the web app and worker (`ecosystem.config.js`,
`docs/operations/DEPLOYMENT.md`) — reuse the same tool rather than introducing a new one. Nothing
needs to change in this repo's checked-in `ecosystem.config.js` to do this; start the Hermes
execution runtime as its own ad-hoc PM2 app:

```bash
cd /opt/trading-intelligence/platform/web

pm2 start npm --name "hermes-market-runtime" --cwd "$(pwd)" -- run market:runtime
pm2 save
pm2 startup   # follow the printed instructions once, so PM2 survives a VPS reboot

# Status / logs
pm2 status
pm2 logs hermes-market-runtime

# Restart after a code update (see §2)
pm2 restart hermes-market-runtime
```

`npm run market:decide` is one-shot by design — invoke it directly (§9) rather than under PM2; it
is not a long-running process. PM2's default stop signal is `SIGINT`, which is exactly what
`market-runtime.ts`'s own signal handler expects for a bounded graceful shutdown — no extra PM2
config is needed for that to work correctly.

For Hermes's own gateway (`hermes gateway start`), consult Hermes's own docs for whether it already
daemonizes itself; if not, the same pattern applies (`pm2 start hermes --name "hermes-gateway" --
gateway start`).

**Hermes's local invocation boundary**: Hermes Agent has its own local tool/skill system
(`hermes tools`, plus a skills directory compatible with the `agentskills.io` standard) with a
"local" backend for running shell commands on the same machine it's installed on. Register a tool
or small skill there (see Hermes's own docs — the exact registration schema was not fully specified
in the fetched README) whose commands are exactly the ones already in this runbook — e.g.
`cd /opt/trading-intelligence/platform/web && npm run market:decide`,
`pm2 restart hermes-market-runtime`, `pm2 logs hermes-market-runtime --lines 50 --nostream`. This is
the "simplest officially supported local mechanism" — no new code in this repo, no REST API, no MCP
server.

## 11. Validation commands

```bash
cd /opt/trading-intelligence/platform/web

# eToro connectivity (existing smoke test — opens and closes one small demo trade)
npm run broker:etoro-smoke

# One-shot decision cycle
npm run market:decide

# Continuous runtime — start, confirm it logs a redacted startup summary and
# "Runtime started.", then Ctrl+C and confirm clean shutdown (state: STOPPED, timedOut: false)
# in the final status JSON it prints.
npm run market:runtime
```

- **Telegram (Trading Platform bot)**: after `market:runtime` logs "Telegram bot started...", send
  `/help` from the allowed chat id and confirm a reply listing all eight commands; send `/status`
  and confirm it matches the process's actual state.
- **Telegram (Hermes gateway)**: after `hermes gateway start`, message Hermes's own bot and confirm
  it replies.
- **Hermes invoking this repo**: from within a Hermes chat/session, ask it to run the registered
  local tool/skill from §10 (e.g. trigger `npm run market:decide`) and confirm its reported output
  matches what you see running that command directly.

## 12. Rollback and stop commands

```bash
# Stop the continuous runtime gracefully (SIGINT — bounded, see HERMES_RUNTIME_SHUTDOWN_TIMEOUT_MS)
pm2 stop hermes-market-runtime
# ...or, if running in a foreground terminal instead of PM2:
#   Ctrl+C

# Roll back to a previous known-good commit
cd /opt/trading-intelligence
git log --oneline                 # find the commit hash to roll back to
git checkout <previous-commit-hash>
cd platform/web
npm install
npm run build                     # optional but recommended, see §4
pm2 restart hermes-market-runtime
```

```bash
# Stop Hermes Agent
hermes gateway stop    # check `hermes gateway --help` for the exact subcommand on your installed
                        # version — the fetched README documented `start` explicitly but not `stop`
```

## 13. Known limitations, carried forward from `docs/prototype-v1-vps-handoff.md`

- **Trade history does not survive a restart.** The currently committed code
  (`InMemoryTradeLifecycleStore`, `JsonFileAuditTrail.createFresh`) keeps lifecycle records
  in-memory only and truncates the audit log fresh on every process start. `/positions`, `/trades`,
  and `/pnl` all reset after a crash, redeploy, or `pm2 restart`. Any *open* eToro position itself
  is unaffected on eToro's side — only this pipeline's own record of it is lost until manually
  reconciled. (A persistence/reconciliation improvement for this was scoped in a separate mission
  but is **not** part of the code this runbook deploys.)
  - Practical consequence: avoid restarting `hermes-market-runtime` while a position is open unless
    you're prepared to reconcile it manually against the eToro demo account.
- **Trading212 is unsupported and fails closed** at startup validation, before any broker call.
- **No structured trade-review/learning-history generation** — Telegram commands report only
  already-computed figures (win rate, realised P/L) from in-memory lifecycle records.
- **Hermes Agent details in §7/§8/§10 are drawn from its public README** as of this writing; exact
  config-file schema, non-interactive credential env vars, and the gateway's stop subcommand were
  not fully specified there — confirm against `hermes-agent.nousresearch.com/docs` and
  `hermes --help` / `hermes gateway --help` directly on the VPS before relying on them.
