# Agent Note: One translation activates the project's Chinese prompt and catalog

Status: implemented

English | [中文](2026-09-08-auto-locale-prompt-and-skill-catalog.zh.md)

## Problem

The translation commands produced durable project artifacts, but using them still required deployment configuration: `completePromptFile` had to point at the translated prompt and `catalogLocale` had to be set to `zh`. A user who ran the commands once could still receive English model input until configuration and restart caught up.

## Decision

Translation artifacts are self-activating per project. `system-prompt` defaults `autoTranslatedPrompt` to `true` and resolves `translatedPromptFile` (default `.dsh/system-prompt.zh.prompt.md`) against the assembling session's workspace; `assembleContextFor` supplies that workspace. A missing file keeps the standard assembly, while an existing empty or unreadable file fails loudly. An explicit `completePromptFile` or another effective complete section wins. `tool-skill` defaults `catalogLocale` to `auto`: one valid description in `.dsh/skill-translations.zh.json` selects Chinese framing and archived descriptions, with per-entry fallback to the original description. The catalog's durable `source.entries` records the descriptions actually published, so its digest changes when translations change and a later step appends a replacement catalog.

## Alternatives considered

- **Let the command rewrite profile configuration.** Rejected: a user command would mutate deployment-owned configuration, and project-relative artifacts would still need per-project path handling.
- **Register the translated prompt only in the current agent scope.** Rejected: it would not survive resumed or newly created sessions for the same project.
- **Keep hashing only original catalog descriptions.** Rejected: the Chinese model-visible catalog would not be reconstructable from the Session log, and refreshing translations would not republish the changed model input.

## Consequences

- One completed `/translate-system-prompt` run is enough for later assemblies in that project; the next turn after the child writes the file uses it without a process restart.
- One completed `/translate-skills` run is enough for the catalog. `catalogLocale: en` remains the explicit opt-out, and `zh` forces Chinese framing even before an archive exists.
- The translated prompt is still a snapshot; changed plugins, tools, or persona require rerunning `/translate-system-prompt`.
- Explicit deployment overrides remain stronger than project auto-selection.
