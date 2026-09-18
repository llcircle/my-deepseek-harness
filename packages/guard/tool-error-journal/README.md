---
description: "JSONL journal of failed tool calls for users and maintainers inspecting errors or feeding AI-assisted correction."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-error-journal

English | [中文](README.zh.md)

## Summary

A failed tool call already reaches the model as an error result and then disappears into the session log. `dsh-tool-error-journal` keeps a durable, cross-session record: it observes the post-commit session feed, selects failed `tool/result` records from every session in the process (core and MCP tools both surface through the same event), and appends one bounded JSON line per failure to a JSONL file. The journal is write-only state for operators and correction tooling; nothing reads it back. Choose it to answer "which calls failed, when, and why" across sessions; skip it when per-session log inspection is enough.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the session store and it starts journaling — no other wiring is required.

### When to choose it

Choose it when operators or correction tooling need a durable, process-wide record of tool failures that survives session boundaries. Skip it when the session log is the only consumer: the same `tool/result` records are already durable there, so the journal adds value only through its single-file, cross-session shape.

### Set up

```yaml
- name: '@deepseek-ai/dsh-tool-error-journal'
```

| Field | Default | Meaning |
|---|---|---|
| `path` | `tool-error-log.jsonl` under the Harness home | JSONL sink; a relative path resolves under `$DSH_HOME` or `~/.dsh` |
| `maxTextChars` | `4000` | Cap on the model-facing failure text excerpt stored per entry |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-error-journal) is the exhaustive source for every accepted field.

### Entry shape

One JSON object per line:

```json
{"time":"2026-09-08T00:00:00.000Z","sessionId":"…","seq":7,"name":"mcp__memorix__save","callId":"call-1","text":"Error: …"}
```

`name` is learned from the paired `tool/call` record and reads `unknown` when the journal sees a result whose call record was never observed. An internal failure identity (for example a timeout) is carried in `internalError` beside the model-facing text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the journal observes failures and writes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Observe, never intercept.** The plugin registers one `session/event` listener on the post-commit feed and appends asynchronously; it sits outside the tool dispatch path, so it cannot change any result.
- **The session log stays the authority.** The journal is a derived, best-effort projection: a failed append is logged and contained, never retried across restarts, and never blocks the emitter.
- **Bounded entries.** The failure text is excerpted to `maxTextChars`; the tool-name memory is a per-session map that deletes each call identity when its result arrives, so it cannot grow without bound.

### Failure selection and pairing

A `tool/call` record stores `callId → name` per session. A `tool/result` record journals when its single tool-result block carries `isError` or the envelope names an internal `error`; the entry pairs the stored name, caps the joined text blocks at `maxTextChars`, and stamps the event's own time and sequence.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the `session/event` tap, the serialized append queue |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session subsystem reference](../../../docs/subsystems/session.md) — the durable `tool/result` records this journal derives from.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

None, as the journal writes only an operator-facing file and registers no prompt section, tool, or session event the model reads.

#### KV Cache effect

Independent: the journal contributes no model-visible content, so it never changes the reusable request prefix.

## Known Limitations and Deferred Work

- **Best-effort, not transactional** — a failed append (unwritable path, disk error) drops that entry after an operator-log warning; the session log remains the complete record.
- **Tool names need the paired call record** — a result observed without its `tool/call` predecessor journals under `unknown`; seeds replayed into a fresh process before the journal mounted look exactly like that.
- **Single-process scope** — the journal records the sessions of the process that mounts it; it is not a cluster-wide sink.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: the planned correction command reads this file and hands recent entries to a background subagent that writes a reflection document.

</details>

**Runtime invariant:** No companion is published. The journal is append-only, write-only state for operators and correction tooling; nothing reads it back into the loop, so no loop-visible relation exists.
