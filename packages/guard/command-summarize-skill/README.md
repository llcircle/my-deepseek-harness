---
description: "The /summarize-skill command: background capture of recent conversation into a project skill file, for users preserving workflows and maintainers composing the flow."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-summarize-skill

English | [中文](README.zh.md)

## Summary

A conversation that just solved a problem contains a workflow worth keeping — and it evaporates when the session ends. `/summarize-skill` captures it: the command extracts the newest user/assistant text turns from the receiving agent's session, starts ONE background one-shot subagent whose prompt carries the excerpt and orders it to write the distilled workflow as a project skill file (`<skillsDir>/<kebab-name>/SKILL.md`, default `.dsh/skills/`), and reports the child run id immediately. The child runs independently of the main conversation; the skill filesystem provider watches the directory, so the new skill enters the catalog without any manual invalidation. The command runs no model work itself and writes nothing — the child owns the file through its own write tool, sandbox, and approvals.

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

Choose it when users should be able to promote a just-finished conversation into a reusable skill with one gesture, off the main line. Skip it when skills should only be authored deliberately by hand — this command captures whatever the recent turns taught, and the child decides whether the excerpt is worth a skill at all.

### Set up

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-summarize-skill'
```

| Field | Default | Meaning |
|---|---|---|
| `skillsDir` | `.dsh/skills` | Skill root the child writes into; relative to the child's workspace |
| `maxTurns` | unlimited | Optional cap on the user/assistant text turns handed to the child; omit for the full conversation |
| `provider` | `spawn` | Subagent provider that runs the summarization child |
| `childTools` | `["read", "write"]` | Tools this child keeps; every other inherited tool is removed. An empty list leaves its tool set untouched |
| `childOmitSections` | `["harness:identity", "deployment:persona-prefix", "deployment:error-lessons"]` | Prompt sections this child does not get |

### Running it

Type `/summarize-skill` after a conversation worth keeping. The input after the command name is parsed as an optional selection plus guidance: a leading `N` keeps the newest N turns, a leading `N-M` selects that 1-based inclusive range over the full conversation, and the remaining text — or the whole input without a leading selector — is user guidance the child follows over the generic rule. `/summarize-skill` hands over the whole main-line conversation; `/summarize-skill 3` the newest three turns; `/summarize-skill 2-5 部署流程` the chosen range with that guidance. Outcomes the acknowledgement reports:

- **No conversation text** — an error naming the empty capture; no child starts.
- **Invalid selection** — an error naming the out-of-range or malformed selector; no child starts.
- **Summary started** — success naming the child run id and the skill root; the child decides the skill name, writes the file, and settles in the background.
- **Missing runtime** — an error naming the absent subagent runtime or provider, rather than a silent skip.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command extracts turns and delegates; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Extract, never interpret.** The handler reads committed `user/message` (user-source only) and `assistant/message` (non-interrupted) text turns from the session and hands them to the child verbatim; whether the content teaches a workflow is the child's judgment, and the prompt tells it to reply `no reusable workflow` without writing when it does not.
- **The child owns the file.** The prompt names the skill-root convention and the frontmatter contract (`name:`/`description:`), and the child creates `<skillsDir>/<kebab-name>/SKILL.md` through its own write tool — parent directories included — so sandbox and approval policy apply unchanged.
- **Catalog refresh is automatic.** The filesystem skill provider watches the skill root, so the child's write invalidates the catalog through the ordinary watcher path; this command does no registry work.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, turn extraction, the capture prompt, the `/summarize-skill` handler |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the provider registry and catalog this command feeds through the filesystem provider.
- [Subagent subsystem reference](../../../docs/subsystems/subagent.md) — the delegation seam that runs the summary child.
- [guard group map](../README.md) — the sibling guard packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the summary child: the command's own acknowledgement is human-facing only, while the started subagent receives the capture prompt as its user message through the delegation seam that owns its delivery.

#### KV Cache effect

Independent of the main conversation: the child is its own session with its own prefix; the main conversation's request prefix never changes because a capture ran.

## Known Limitations and Deferred Work

- **Text turns only** — images, files, and tool results in the captured turns are invisible to the child; a workflow that lives in tool call arguments does not survive the excerpt.
- **No name control** — the child chooses the kebab-case skill name; a user who wants a specific name edits the file or frontmatter afterward.
- **No completion notice** — the command reports the child id and returns; watching the child settle is the subagent surface's job, not this command's.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: an explicit turn-range argument (`/summarize-skill <from>..<to>`) reusing the same prompt builder instead of the newest-turns default.

</details>
