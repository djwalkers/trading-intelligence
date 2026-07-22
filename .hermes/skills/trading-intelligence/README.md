# Trading Intelligence — Hermes Skill Pack

A [Agent Skills](https://agentskills.io)–format skill that teaches Hermes Agent how to inspect the
Trading Intelligence platform through its existing, read-only
[Integration API v1](../../../docs/hermes-integration-api.md). This is documentation for people
maintaining the skill — the agent-facing instructions themselves live in `SKILL.md`.

## Why this exists

Before this skill, operating Hermes against Trading Intelligence would mean re-explaining the
platform — its endpoints, response shapes, honesty conventions (`null` vs `"unknown"` vs a failed
call), and its strict read-only boundary — in every conversation via a long prompt. This skill
packages that knowledge once, versioned alongside the platform it describes, so Hermes loads it on
demand instead.

## What's in this directory

```
trading-intelligence/
├── SKILL.md                              Agent-facing instructions (loaded by Hermes when relevant)
├── README.md                             This file — human-facing overview
├── DEVELOPER_NOTES.md                    Design decisions, assumptions, open questions
├── INSTALL.md                            How to register this skill with a running Hermes install
├── references/
│   ├── api-reference.md                  Full endpoint/field reference
│   ├── safety-and-limitations.md         The read-only boundary + every known API limitation
│   ├── example-conversations.md          Sample exchanges, correct tone, refusals
│   └── reasoning-examples.md             Worked multi-step reasoning ("why didn't BTC trade?")
└── scripts/
    └── call-api.sh                       Thin, read-only wrapper around the Integration API
```

This follows the official Agent Skills directory structure (`SKILL.md` required;
`scripts/`/`references/`/`assets/` optional, any other files permitted) — see
`DEVELOPER_NOTES.md` for the exact specification this was validated against.

## Relationship to the platform

This skill describes the API in `docs/hermes-integration-api.md` (repo root) — it does not
reimplement, wrap, or extend that API's behavior. If the two ever disagree, the platform doc and a
live response are authoritative; update this skill to match, not the other way around. This skill
pack does not modify anything under `platform/web/` — it is purely additive documentation +
instructions for an external agent.

## Scope

**v1 is read-only**, and so is this skill's entire understanding of the platform. It does not
teach Hermes to pause/resume trading, place orders, or change configuration, because the API it
describes cannot do any of that yet. See `references/safety-and-limitations.md`.

## Maintaining this skill

If the Integration API changes (new endpoint, changed field, new error code), update, in this
order: `docs/hermes-integration-api.md` (source of truth) → `references/api-reference.md` (this
skill's summary of it) → `SKILL.md`'s endpoint table if the change affects *when* to call
something → the example/reasoning files if a worked example is now stale.
