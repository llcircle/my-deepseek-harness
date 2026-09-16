# Agent Note: /summarize-skill takes selection and guidance, not guesses

Status: implemented

English | [中文](2026-09-08-summarize-skill-selection-and-guidance.zh.md)

## Problem

`/summarize-skill` handed the child the whole conversation and a generic rule, so the child guessed what was worth capturing. A user who knew which turns taught the workflow — and what the skill should emphasize — had no way to say so.

## Decision

The command now parses its input into an optional selection plus free-text guidance. A leading `N` keeps the newest N turns; a leading `N-M` selects that 1-based inclusive range over the full conversation; the remaining text (or the whole input without a selector) is guidance, and with guidance present the child follows it over the generic "decide for yourself" rule. The configured `maxTurns` still caps the final selection, so a deployment can bound delegation cost regardless of input.

## Alternatives considered

- **Structured subcommands or flags.** Rejected for now: one slash command with a prefix selector stays usable from any command surface without per-surface UI.
- **A message-picker UI.** Deferred: the client has no per-command custom input surface yet; the selector grammar is the command-level contract a future picker would feed.

## Consequences

- Invalid selectors fail loudly with the offending numbers before any child starts.
- Guidance is model-visible in the child's prompt but touches neither the main conversation prefix nor the session log.
