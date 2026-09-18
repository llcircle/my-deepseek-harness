---
description: "The /correct-errors command: fuses the tool error journal with the prior lessons into the system-level reflection document, archives the raw failures, and clears the journal."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-correct-errors

English | [中文](README.zh.md)

## Summary

A journal full of failed tool calls fixes nothing by itself, and lessons scattered across runs are lost lessons. `/correct-errors` runs one correction pass: it reads the newest failed calls from the tool error journal and the existing reflection document (default `<dshHome>/error-reflections.md`), starts ONE background one-shot subagent ordered to merge both into the rewritten document, then archives the raw journal content (`<dshHome>/tool-error-log-archive.jsonl`) and clears it. The command runs no model work itself, and the child's result lands on the subagent surface, not in your chat.

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

### When to choose it

Choose it when users should be able to invoke a correction pass on demand and let the reflection writing happen off the main line. Skip it when corrections should run automatically on every failure — that would need a different trigger, and this package deliberately starts work only when the user asks.

### Set up

```yaml
- name: '@deepseek-ai/dsh-tool-error-journal'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-correct-errors'
```

| Field | Default | Meaning |
|---|---|---|
| `journalPath` | `tool-error-log.jsonl` under the Harness home | Journal file the command reads; a relative path resolves under `$DSH_HOME` or `~/.dsh` |
| `archivePath` | `tool-error-log-archive.jsonl` under the Harness home | Append-only archive every cleared journal content lands in |
| `reflectionDocPath` | `error-reflections.md` under the Harness home | System-level document the child rewrites; lessons persist across projects |
| `provider` | `spawn` | Subagent provider that runs the correction child |
| `maxErrors` | `20` | Maximum journal entries handed to the child, newest last |
| `maxReflectionChars` | `8000` | Tail cap on the existing reflection document handed to the child |
| `childTools` | `["read", "write"]` | Tools the correction child keeps; every other inherited tool is removed. An empty list leaves its tool set untouched |
| `childOmitSections` | `["harness:identity", "deployment:persona-prefix", "deployment:error-lessons"]` | Prompt sections the child does not get |

### Running it

Type `/correct-errors` in any command-capable surface. Outcomes the acknowledgement reports:

- **No errors recorded** — success with `No tool errors recorded; nothing to correct.`; no child starts.
- **Correction started** — success naming the child run id, the reflection document, and the archive; the journal content moved to the archive and the journal cleared, while the child rewrites the reflection document in the background.
- **Missing runtime** — an error naming the absent subagent runtime or provider, rather than a silent skip.
- **Archiving failure** — an error naming the fault; the child keeps running, and the journal stays as-is for the next pass.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command hands the journal to a child; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **User-invoked, not automatic.** The command registry owns the trigger; the handler starts exactly one one-shot child per invocation and returns at once. No listener watches failures to self-trigger corrections.
- **The child owns the model work; the command owns the bookkeeping.** The prompt orders the child to merge the prior lessons with the new failures and rewrite the whole reflection document with its own write tool. The command itself performs the file bookkeeping — append raw journal to the archive, clear the journal — only after the child has started, so a failed start never loses journal data.
- **The journal is a queue, the archive is the ledger.** Clearing the journal bounds each pass; the append-only archive preserves every raw failure forever, so imperfect reflections never destroy evidence.

### Prompt shape

The child's prompt carries the prior lessons (capped tail), the newest entries oldest-first — one line per failure with time, tool name, call id, optional internal failure identity, and the bounded text — and orders the child to rewrite the complete document with one new dated section synthesizing the new failures against the prior lessons.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, journal reader, reflection prompt, the `/correct-errors` handler |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- The tool error journal (`@deepseek-ai/dsh-tool-error-journal`) — the JSONL feed this command reads.
- [Subagent subsystem reference](../../../docs/subsystems/subagent.md) — the delegation seam that runs the correction child.
- [guard group map](../README.md) — the sibling guard packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the correction child: the command's own acknowledgement is human-facing only, while the started subagent receives the reflection prompt as its user message through the delegation seam that owns its delivery.

#### KV Cache effect

Independent of the main conversation: the child is its own session with its own prefix; the main conversation's request prefix never changes because a correction ran.

## Known Limitations and Deferred Work

- **One child per invocation, no dedup** — two `/correct-errors` calls start two children; neither knows about the other, and both append to the same document.
- **Journal format coupling** — the reader expects one JSON `ToolErrorEntry` per line; a truncated or hand-edited line fails the command with a read error instead of being skipped.
- **No completion notice** — the command reports the child id and returns; watching the child settle is the subagent surface's job, not this command's.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: an automatic trigger that starts the same reflection after a configurable number of journal entries, reusing the same prompt builder.

</details>

**Runtime invariant:** No companion is published. The command runs no model work of its own and keeps no in-process state; the child owns every write, and the journal and reflection document are operator-owned files.
