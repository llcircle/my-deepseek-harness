# Agent Note: The translated prompt replaces the assembled prompt through one complete section

Status: implemented

English | [中文](2026-09-08-complete-prompt-file-locale-override.zh.md)

## Problem

`/translate-system-prompt` produced a bilingual archive for humans, but the model kept receiving the assembled English prompt. Users who want a deployment whose model-facing workflow reads in Chinese had no path from "translated" to "actually used".

## Decision

`system-prompt` gains `completePromptFile`: an absolute path to a UTF-8 file registered as a complete section when the file exists at construction. A complete section restores itself as the sole prompt section, so the file's content replaces every assembled section (identity, persona, tool prose) while tool schemas, contexts, and variables still resolve. Load-time semantics: missing file means unconfigured (standard English assembly); any other read failure fails the plugin at load. Once active, the file is re-read per assembly and its disappearance fails that request loudly — silently downgrading back to English would hide a broken locale deployment. `/translate-system-prompt` now writes a second, translation-only file (default `.dsh/system-prompt.zh.prompt.md`) intended as that path; re-running the command refreshes it; the default automatic selection picks up the new content on a later assembly.

## Alternatives considered

- **Per-section i18n dictionaries inside every contributing plugin.** Rejected for now: the prose lives across dozens of packages, and the translation would fragment into per-package maintenance with no single reviewable artifact.
- **Runtime prompt re-translation inside the assembly path.** Rejected: a model call inside prompt assembly couples request latency to translation and makes the model-visible prompt nondeterministic across restarts.
- **Silent fallback to English when the file disappears at runtime.** Rejected: a locale deployment that quietly reverts languages is a misconfiguration wearing a success mask; the loud error points at the deleted file.

## Consequences

- The archive stays the human-readable bilingual record; the prompt-only file is the machine-consumed half, kept in one write per refresh.
- The translated snapshot freezes the prompt at translation time; deployment changes (new tools, changed persona) require re-running the translation.
- KV Cache: the complete section is prefix-stable while the file is unchanged and shifts the whole system-prompt prefix when refreshed.
