# Agent Note: Per-skill trigger-state overrides for local skills

Status: implemented

English | [中文](2026-09-07-skill-trigger-state-overrides.zh.md)

## Problem

Skill invocation controls existed only as per-file frontmatter (`disable-model-invocation`, `user-invocable`). A deployment that wants to turn one discovered skill passive, restrict it to explicit user invocation, or hide it entirely had to edit each skill file — awkward for bundled or third-party skills the deployment does not own, and impossible to change at runtime.

## Decision

`@deepseek-ai/dsh-skill` owns the vocabulary: a `SkillTriggerState` union — `passive` (both surfaces), `active-only` (explicit user invocation only), `ignored` (hidden from every catalog) — and `invocationPolicyForTriggerState()` mapping each state onto the existing `SkillInvocationPolicy` booleans. No new filtering logic exists anywhere; the states compile to the same two bits every consumer already reads.

`@deepseek-ai/dsh-skill-filesystem` accepts an `invocationOverrides` record (skill name → trigger state) in its config and applies it over the frontmatter policy in both discovery and load, so the winning policy is identical whether a consumer lists the catalog or loads a body. Keys are validated at plugin load: a key that is not a valid skill name fails the load instead of silently matching nothing.

## Alternatives considered

- **A third `triggerState` field on `SkillSummary`.** Rejected: consumers would either duplicate the state-to-bits mapping or keep reading the booleans, and every provider (runtime, filesystem, future remote ones) would have to populate another field for the same information.
- **Global enable/disable lists.** Rejected: names-only lists cannot express the middle state, and "enabled" would silently mean different things for model and user surfaces.
- **Editor-side filtering only (hide ignored skills at the UI).** Rejected: ignored skills would still be loadable by name and still cost discovery work; the policy belongs where discovery happens.

## Consequences

- Deployments control skill visibility per skill from one configuration place without touching skill files; the map wins over frontmatter, so a skill file stays the single source for its default.
- `ignored` still lists the skill internally with both surfaces false; consumers that render catalogs already skip non-invocable skills, so no registry-level hiding was added. A future consumer that iterates raw candidates sees the policy bits and must honor them.
- A stale override for a skill that no longer exists is not an error; validating against discovery results would require deferring load failures to a cwd-sensitive moment the load-time contract cannot express.
