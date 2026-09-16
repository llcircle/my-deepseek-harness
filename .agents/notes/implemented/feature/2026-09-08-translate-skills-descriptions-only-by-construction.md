# Agent Note: Translating skill summaries keeps bodies out by construction

Status: implemented

English | [中文](2026-09-08-translate-skills-descriptions-only-by-construction.zh.md)

## Problem

Skill catalogs mix author languages, and a reader scanning for the right skill fights vocabulary first. Translating "the skills" wholesale was never the goal — bodies are instructions the model executes verbatim, and translating them risks semantic drift in exactly the text that steers tool use — but nothing let a user archive just the human-facing summaries in their own language.

## Decision

`/translate-skills` builds the child prompt from `toSummaryEntry()`, a projection that keeps exactly `name`/`description`/`whenToUse` from each catalogued skill. The child translates the two summary fields into the configured locale and writes one JSON archive keyed by the untranslated skill name. Because bodies never enter the prompt, the scope "descriptions only" is enforced by what the prompt cannot contain, not by an instruction the model is asked to obey.

## Alternatives considered

- **Prompting the model to translate descriptions and ignore bodies.** Rejected: the rule would live in prose the model might disobey, and shipping bodies into the prompt to ignore them wastes delegation tokens and risks quoting them into the archive.
- **Translating at catalog-read time inside `dsh-skill`.** Rejected: the registry is a synchronous read/merge seam; adding model calls there couples discovery latency to translation, and the registry's contract has no locale dimension.
- **Storing translations in the skill frontmatter.** Rejected: frontmatter is the author's source of truth; merging machine translations into it would make every regeneration a diff against the author's file.

## Consequences

- The archive is a plain JSON file keyed by skill name, readable by any consumer (UI overlays, locale-aware catalogs) without touching the registry.
- Descriptions drift when skills change until the command is re-run; the archive is a snapshot, deliberately not a synchronized mirror.
- The summary-only projection means multi-language catalogs converge into one predictable file shape per locale.
