# Agent Note: Skill capture extracts turns and leaves the judgment to the child

Status: implemented

English | [中文](2026-09-08-summarize-skill-extract-dont-judge.zh.md)

## Problem

A conversation that just worked through a deployment, a migration, or a debugging session contains a repeatable workflow, but capturing it meant hand-writing a SKILL.md afterward: recalling the steps, choosing a name, creating the directory, and getting the frontmatter right. Nothing connected "the conversation that taught it" to "the skill that preserves it".

## Decision

`/summarize-skill` extracts the newest committed user/assistant text turns from the receiving agent's session — user-source messages only, non-interrupted assistant messages, text blocks only — and starts one background one-shot subagent with the excerpt and the skill-file contract (`<skillsDir>/<kebab-name>/SKILL.md`, frontmatter `name`/`description`). The child decides whether the excerpt teaches a workflow at all (replying `no reusable workflow` without writing when not) and owns the file write through its own tool path. The command itself extracts and delegates; it never judges, names, or writes.

## Alternatives considered

- **Judging "skill-worthiness" in the command handler.** Rejected: the handler runs no model work, so a heuristic threshold would capture noise; the excerpt is data, and only a model reading it can decide whether a durable skill exists in it.
- **A dedicated skill-authoring service on `ctx.skills`.** Rejected: the registry is a read/merge seam for providers, not a writer; skill files are the filesystem provider's source of truth, and the child writing through the ordinary filesystem keeps one write path with the watcher owning catalog refresh.
- **Prompting the MAIN agent to write the skill inline.** Rejected: it hijacks the conversation, conflates capture with execution, and makes the skill's cost part of the current turn's context instead of an independent pass.

## Consequences

- One gesture after a working conversation yields a candidate skill in the watched project root, with the filesystem provider refreshing the catalog automatically.
- Tool calls, images, and file attachments in the captured turns are invisible to the child; workflows living in tool arguments need the turn-range or richer-excerpt follow-up before they capture cleanly.
- Repeated invocations can produce overlapping skills; deduplication stays a human (or future correction-pass) concern, matching the write-only journal precedent.
