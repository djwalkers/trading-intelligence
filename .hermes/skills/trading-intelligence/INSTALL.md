# Installation

This skill lives in the Trading Intelligence repository at
`.hermes/skills/trading-intelligence/` so it's version-controlled alongside the platform it
describes. Hermes Agent's own documented discovery, however, looks at a global
`~/.hermes/skills/` directory (plus anything explicitly listed in `skills.external_dirs`) — it does
not automatically scan a project-local `.hermes/skills/` folder. See `DEVELOPER_NOTES.md`,
"Discovery," for the full reasoning. Pick one of the two options below.

## Option A — register this path as an external directory (recommended)

Keeps the skill in this repo as the single source of truth; no copying, no drift.

1. Open (or create) `~/.hermes/config.yaml` on the machine running Hermes.
2. Add this repository's skills directory to `skills.external_dirs`, e.g.:

   ```yaml
   skills:
     external_dirs:
       - /absolute/path/to/Trading/.hermes/skills
   ```

   Use the real absolute path to this repository's `.hermes/skills` directory on that machine —
   not a relative path.
3. Restart Hermes (or reload its config, per whatever your installed version supports).
4. Confirm it's discovered:

   ```bash
   hermes skills list
   ```

   You should see `trading-intelligence` in the listing.

## Option B — symlink into the global skills directory

If your Hermes installation doesn't support `external_dirs`, or you prefer the global directory:

```bash
ln -s /absolute/path/to/Trading/.hermes/skills/trading-intelligence \
      ~/.hermes/skills/trading-intelligence
```

A symlink (rather than a copy) keeps the skill in sync with the repo automatically. If your
installed Hermes version turns out to require the documented `<category>/<skill-name>/` layout for
discovery (unverified — see `DEVELOPER_NOTES.md`), nest it one level deeper instead, e.g.:

```bash
mkdir -p ~/.hermes/skills/trading
ln -s /absolute/path/to/Trading/.hermes/skills/trading-intelligence \
      ~/.hermes/skills/trading/trading-intelligence
```

## Required environment for the skill to actually work

The skill's instructions (and its `scripts/call-api.sh` helper) call the Integration API directly —
Hermes itself needs, in whatever environment it runs commands in:

```bash
HERMES_INTEGRATION_TOKEN=<same token the Integration API is configured with>
```

This must be the **same value** as the `HERMES_INTEGRATION_TOKEN` set for the Trading Intelligence
Next.js app (see `docs/hermes-integration-api.md`) — this skill has no separate credential, and
does not generate or manage one itself.

If the Integration API is reachable at a host/port other than `http://127.0.0.1:3000` (unusual —
see the platform doc's "Local-only enforcement" section for why it should normally stay bound to
loopback), also set:

```bash
TRADING_INTELLIGENCE_BASE_URL=http://127.0.0.1:3000
```

## Verifying the install

With the Integration API running and `HERMES_INTEGRATION_TOKEN` set, run the wrapper script
directly (outside Hermes) as a sanity check before relying on the skill in conversation:

```bash
.hermes/skills/trading-intelligence/scripts/call-api.sh summary
```

You should get back the standard envelope, `"ok": true`, with a `data` object matching
`references/api-reference.md`'s description of `/summary`. If you get a connection error, confirm
the Integration API is actually running (`npm run market:runtime`'s host app, i.e. the Next.js
server — see the platform's own deployment runbook) and reachable at the configured base URL.

Then, in an actual Hermes conversation, ask something the skill's description matches (e.g. "is
Trading Intelligence running?") and confirm Hermes loads and follows this skill rather than
answering generically.
