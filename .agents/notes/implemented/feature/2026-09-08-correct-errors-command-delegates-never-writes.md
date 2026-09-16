# Agent Note: The correction command delegates, never writes

Status: implemented

English | [中文](2026-09-08-correct-errors-command-delegates-never-writes.zh.md)

## Problem

The tool error journal records failures but fixes nothing, and reviewing failures by hand does not scale. A correction flow needs model work — root-cause reading and a written reflection — but that work must not ride the main conversation: it should start on an explicit user gesture and run in the background.

## Decision

`/correct-errors` is a read-only command: it reads the newest journal entries (bounded, oldest first), starts exactly one one-shot subagent through the delegation seam with a reflection prompt, and returns the child run id at once. The child owns all mutation — the prompt orders it to summarize causes/fixes and append a dated reflection section to the configured document using its own write tool, so the child's tools, sandbox, and approvals govern the write exactly like any other tool use. An absent subagent runtime or provider, or an unreadable journal, fails the command loudly; an empty journal succeeds without starting a child.

## Alternatives considered

- **Writing the reflection from the command handler.** Rejected: the handler runs without a model turn, so "AI summarizes" would become templated text; the reflection needs real model reasoning, which is exactly what the delegation seam provides.
- **Steering the main conversation with a correction prompt.** Rejected: that hijacks the main line the user was using and makes the reflection synchronous; the requirement is a background, independent pass.
- **An automatic trigger on every Nth failure.** Rejected for this package: silent background children per threshold would surprise compositions that journal heavily; the documented open direction keeps the same prompt builder behind an explicit future opt-in.

## Consequences

- One user gesture yields a durable reflection document without touching the main conversation, and every correction is visible on the subagent surface with its own session.
- Two invocations start two children that both append to the document; deduplication and completion notices remain the subagent surface's job.
- The command depends on the journal's JSONL shape; the session log remains the authoritative record the journal itself derives from.
