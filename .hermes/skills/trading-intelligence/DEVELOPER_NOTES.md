# Developer Notes

Design decisions, assumptions, and open questions behind this skill pack — written for whoever
maintains it next.

## Format this was validated against

Hermes Agent (NousResearch/hermes-agent) documents its skills system as compatible with the
[agentskills.io](https://agentskills.io) open standard. This skill was authored strictly against
that standard's published specification (fetched directly from agentskills.io/specification):

- `SKILL.md` frontmatter fields used: `name`, `description`, `license`, `compatibility`,
  `metadata` — every one of these, its required/optional status, and its constraints (e.g. `name`
  max 64 chars, lowercase/hyphens only, must match the directory name; `description` 1–1024
  chars) is drawn directly from that spec, not guessed.
- `metadata` is used strictly as the spec defines it — **a flat map from string keys to string
  values** (e.g. `tags: "trading, portfolio, ..."` as one comma-separated string, not a YAML list
  or nested object) — even though a nested structure might read more naturally, to stay
  unambiguously within the documented shape.
- Directory layout (`SKILL.md` + optional `scripts/`, `references/`, `assets/`, plus any other
  files) matches the spec's own documented structure. This skill uses `SKILL.md`, `scripts/`, and
  `references/`; it does not use `assets/` (nothing here is a template/image/data file).

## Deliberately NOT used: Hermes-specific frontmatter extensions

Hermes's own documentation (fetched from hermes-agent.nousresearch.com) describes additional,
Hermes-specific fields nested under `metadata.hermes` — `tags` (as a list), `category`,
`fallback_for_toolsets`, `requires_toolsets`, `fallback_for_tools`, `requires_tools`, a `config`
array, plus top-level `platforms` and `required_environment_variables`.

**None of these are used in this skill's `SKILL.md`.** Two reasons:

1. The core agentskills.io spec defines `metadata` as string-to-string only — nesting an object or
   array as a metadata value (as Hermes's own examples show) isn't unambiguously within that
   documented shape, and this skill was written to stay strictly spec-compliant rather than assume
   a specific implementation's extension behaves as advertised.
2. The exact accepted values for the conditional-activation fields (`requires_tools`,
   `requires_toolsets`, etc.) weren't independently verified against a live Hermes installation —
   using them with guessed values would risk exactly the "invented field" this mission explicitly
   ruled out.

**If you have a live Hermes install and want tighter integration** (e.g. declaring
`required_environment_variables: [HERMES_INTEGRATION_TOKEN]`, or `category`/`tags` for Hermes's own
skill browser), verify the exact accepted shape against that installation's own behavior first
(`hermes skills list`/`hermes skills check` after installing, or Hermes's own current docs), then
add them under a `metadata.hermes` key rather than the top-level `metadata`.

## Discovery: this directory alone is not enough for Hermes to find the skill

Hermes's own documented skill discovery is `~/.hermes/skills/` (a global, per-user directory) plus
any directories listed in `skills.external_dirs` in `~/.hermes/config.yaml`. There is no documented
convention for Hermes to automatically discover a project-local `.hermes/skills/` directory sitting
inside a git repository the way, for example, Claude Code discovers `.claude/skills/`.

This skill was still placed at `.hermes/skills/trading-intelligence/` per the mission's explicit
instruction, and because it's the natural, version-controlled home for a skill describing *this*
specific platform. See `INSTALL.md` for how to actually make Hermes see it (registering this path
as an `external_dir`, or symlinking it into `~/.hermes/skills/`).

Hermes's own documented directory convention for *installed* skills is
`<category>/<skill-name>/`. This skill pack does not use a category subdirectory (it sits directly
at `.hermes/skills/trading-intelligence/`, matching the mission's explicit instruction) — if a
live Hermes installation's discovery turns out to strictly require the `<category>/<skill-name>/`
shape, nest it one level deeper when linking/copying it into `~/.hermes/skills/` (e.g.
`~/.hermes/skills/trading/trading-intelligence/`). This wasn't verified against a live installation
and is called out rather than silently assumed either way.

## Assumptions carried over from the Integration API itself

This skill's instructions assume the Integration API's own documented behavior and limitations are
accurate and current (see `docs/hermes-integration-api.md`) — in particular:

- Base URL `http://127.0.0.1:3000`, bound to loopback only.
- `HERMES_INTEGRATION_TOKEN` is required for every call, with no unauthenticated mode.
- The specific `null`-vs-`"unknown"`-vs-error-envelope conventions documented in
  `references/safety-and-limitations.md`.

If the Integration API changes, this skill needs a corresponding update — see README.md's
"Maintaining this skill" section for the update order.

## Validation performed

- Every frontmatter field, its constraints, and the directory structure were checked field-by-field
  against the fetched agentskills.io specification text (not paraphrased from memory).
- `scripts/call-api.sh` was syntax-checked (`bash -n`) and exercised against a live, locally-running
  instance of the actual Integration API (`/summary`, `/decisions` with a query string, `/runtime`)
  — all three returned the documented envelope shape.
- The reference files' documented field names/behavior were cross-checked against
  `docs/hermes-integration-api.md` line by line while writing them, not reconstructed from memory.
- The `skills-ref` reference validator (the tool the agentskills.io spec itself points to) was not
  run in this pass — see `INSTALL.md`/this file's own history for why, and consider running
  `skills-ref validate .hermes/skills/trading-intelligence` as a follow-up if that tool is
  available in your environment.
