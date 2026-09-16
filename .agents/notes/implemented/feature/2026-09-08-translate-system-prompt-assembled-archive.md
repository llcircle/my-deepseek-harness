# Agent Note: The system-prompt archive stores the assembled prompt, not source files

Status: implemented

English | [中文](2026-09-08-translate-system-prompt-assembled-archive.zh.md)

## Problem

The deployment's injected system prompt is invisible to users: they see its effects but never the text, and there was no way to read the workflow in another language or to keep a record of the exact prompt a session runs.

## Decision

`/translate-system-prompt` assembles the receiving agent's scoped prompt through the system-prompt service — the same `assemble({ agent, scope: agent })` call the agent loop makes per turn — and hands the rendered text to one background one-shot subagent that writes a bilingual markdown archive (`## Original` plus a full `## <locale>` translation). Archiving the assembled result rather than reconstructing from source files means scoped sections, per-agent variables, and interpolated values are captured exactly as the model receives them.

## Alternatives considered

- **Concatenating registered section sources.** Rejected: static text misses variable interpolation and the complete-section override, so the archive could silently diverge from the model-facing prompt.
- **A runtime locale switch rendering the prompt model-face in another language.** Deferred: it changes model behavior and belongs to a locale-aware deployment design, not to a snapshot command.

## Consequences

- The archive is a point-in-time snapshot; prompt changes require re-running the command.
- The child's prompt carries the full rendered prompt once, so very large prompts raise the delegation cost of the pass but never touch the main conversation's prefix.
- Together with `/translate-skills`'s `promptLine` records, the human-facing prompt surface now has a per-locale archive for both the catalog lines and the prompt body.
