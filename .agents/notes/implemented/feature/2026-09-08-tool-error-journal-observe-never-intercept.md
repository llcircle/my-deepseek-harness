# Agent Note: The tool error journal observes, never intercepts

Status: implemented

English | [中文](2026-09-08-tool-error-journal-observe-never-intercept.zh.md)

## Problem

Failed tool calls — model-facing errors, crashed MCP servers, internal timeouts — were durable only inside each session's log. Operators debugging "why does this tool keep failing" had to find the right session first, and planned correction tooling had no process-wide, cross-session feed to read.

## Decision

`dsh-tool-error-journal` taps the post-commit `session/event` feed — outside the tool dispatch path — and appends one bounded JSONL line per failed `tool/result` record (the block's `isError` or the envelope's internal `error`) to a configured file, pairing the tool name from the preceding `tool/call` record. The journal is write-only: a failed append is logged and contained, never retried, and never changes or delays any tool result or session event.

## Alternatives considered

- **A `tools/execute` waterfall wrapper writing the log inline.** Rejected: it would put file I/O on the dispatch path, and a slow or failing sink would delay or break tool results; the post-commit feed gives the same records with none of the coupling.
- **A session-projection unit as the sink.** Rejected: projection folds are in-memory state derivations; a file sink is not foldable state, and the projection seam's contract is to serve typed state to carriers, not to persist operator files.
- **Journaling inside `dsh-mcp-client` only.** Rejected: core tools fail just as meaningfully, and two sinks would duplicate selection, bounding, and file policy.

## Consequences

- Correction tooling (and operators) get one append-only file per process to answer "which tool calls failed, when, and why" without touching session storage.
- The journal is best-effort: an unwritable path drops entries after an operator-log warning, and the session log remains the complete record.
- Entries are bounded (`maxTextChars`) and the name memory deletes each call identity at its result, so neither the file nor the map grows without bound.
