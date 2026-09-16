# Agent Note: Dynamic contexts get authored locale templates, not translation overlays

Status: implemented

English | [中文](2026-09-08-context-locale-chinese-templates.zh.md)

## Problem

`completePromptFile` replaced the assembled prompt sections, but the dynamic contexts (`sandbox:policy`, `approval:policy`, `skill-catalog`) flow through a separate channel and stayed English. A user reading the model-visible workflow in Chinese still fought English policy prose and an untranslated skill catalog.

## Decision

Each of the three context owners gains an authored-locale config instead of a translation overlay: `sandbox-policy.contextLocale` and `user-approval.contextLocale` select between authored English and Chinese templates for their policy prose (policy state still interpolates per session), and `tool-skill.catalogLocale` selects English, Chinese, or automatic Chinese from the per-project `/translate-skills` archive (`.dsh/skill-translations.zh.json`, per-entry fallback to the original). The catalog's durable `source.entries` records the descriptions actually published, so translation changes participate in the digest and append a replacement catalog.

## Alternatives considered

- **A cross-context translation overlay keyed on English prose.** Rejected: string-matching English templates is brittle against wording changes and hides the mapping far from the owning plugin.
- **Consuming the translation archive unconditionally.** Rejected: the archive is optional and may lag the catalog; an explicit locale makes the intent deployment-owned.
- **Including translations in the catalog digest.** Rejected: refreshing translations alone would republish the catalog and shift the conversation prefix for no model-visible fact change.

## Consequences

- An existing session keeps an already-published catalog until a later catalog or translation change appends its replacement.
- A malformed or missing translation archive degrades per-entry to English; the catalog remains usable.
- With a translated prompt, `contextLocale: zh`, and the default automatic catalog locale, every model-visible system-prompt layer — sections, policy contexts, and the skill catalog — reads in Chinese; only MCP tool descriptions remain in the server's own language.
