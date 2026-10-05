---
description: "The /summarize-skill command: background capture of recent conversation into a project skill file, for users preserving workflows and maintainers composing the flow."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-summarize-skill

English | [中文](README.zh.md)

## Summary

A solved problem leaves a workflow worth keeping, and it evaporates when the session ends. `/summarize-skill` captures it: the command extracts the newest user/assistant text turns, starts ONE background one-shot subagent whose prompt carries the excerpt, and reports the child run id; the child writes the distilled workflow as a project skill file (`<skillsDir>/<kebab-name>/SKILL.md`, default `.dsh/skills/`) through its own write tool, sandbox, and approvals. The same prompt runs unprompted at each compaction boundary, where the summary replaces the excerpt and the child may instead revise a skill the deployment already owns. The command itself does no model work.

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
| `autoCurate` | `true` | Also run a curation child at each successful compaction boundary of a top-level session |
| `curateMaxTargets` | `3` | How many owned skills the curation child may be handed in full, for reflection |
| `curateMaxListedSkills` | `30` | How many owned skills the curation prompt lists before reporting the rest as omitted |

### Running it

Type `/summarize-skill` after a conversation worth keeping. The input after the command name is parsed as an optional selection plus guidance: a leading `N` keeps the newest N turns, a leading `N-M` selects that 1-based inclusive range over the full conversation, and the remaining text — or the whole input without a leading selector — is user guidance the child follows over the generic rule. `/summarize-skill` hands over the whole main-line conversation; `/summarize-skill 3` the newest three turns; `/summarize-skill 2-5 部署流程` the chosen range with that guidance. Outcomes the acknowledgement reports:

- **No conversation text** — an error naming the empty capture; no child starts.
- **Invalid selection** — an error naming the out-of-range or malformed selector; no child starts.
- **Summary started** — success naming the child run id and the skill root; the child decides the skill name, writes the file, and settles in the background.
- **Missing runtime** — an error naming the absent subagent runtime or provider, rather than a silent skip.

### Automatic curation at compaction

The same work also runs unprompted, at the one moment a session may change what it will do next without paying for it: the compaction boundary. A compaction replaces the middle of the conversation with a summary and rebuilds the request prefix anyway, so an automatic pass there costs no cache reuse that was not already gone — which is why this is the moment reflection and skill creation are allowed, and why no other moment is.

On a successful `compaction/end` — and only when the session is top-level, a subagent runtime and a skill registry are mounted, the calling agent is still registered, and discovery returned a complete snapshot — one curation child starts for that session. Its prompt carries the summary text, the FULL list of skills this deployment owns, and the bodies of up to `curateMaxTargets` owned skills chosen by BM25 against that summary. It asks the child for at most two changes: create a skill from the work just summarised, and reflect on one existing skill, either performed through the child's own write tool.

Three boundaries keep that honest:

- **Only owned skills are editable.** The corpus is the `.dsh` roots only (`project-dsh`, `user-dsh`). Shared roots (`project-agents`, `user-agents`) and the bundled root stay out, because their files belong to another tool or to the package, and reflection writes to what it is handed.
- **One curation child per session at a time.** A compaction that lands while one is still running is dropped. The marker spans the child's whole lifetime, so it is released only once the child has settled and been disposed.
- **Failure is contained and invisible.** A failed compaction skips curation; a missing runtime, registry, or agent skips it; an incomplete discovery skips it; a child that cannot start is logged and swallowed. The main conversation is never told a curation ran, and no turn waits on one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command extracts turns and delegates; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Extract, never interpret.** The handler reads committed `user/message` (user-source only) and `assistant/message` (non-interrupted) text turns from the session and hands them to the child verbatim; whether the content teaches a workflow is the child's judgment, and the prompt tells it to reply `no reusable workflow` without writing when it does not.
- **The child owns the file.** The prompt names the skill-root convention and the frontmatter contract (`name:`/`description:`), and the child creates `<skillsDir>/<kebab-name>/SKILL.md` through its own write tool — parent directories included — so sandbox and approval policy apply unchanged.
- **Two triggers, one job.** The explicit command and the compaction pass share one prompt builder and one child contract; they differ only in what the child receives — a turn excerpt for the command, the summary plus the owned corpus for the automatic pass — and in when they are allowed to run, which is exactly when the cost of running differs (see [Automatic curation at compaction](#automatic-curation-at-compaction)).
- **Catalog refresh is automatic.** The filesystem skill provider watches the skill root, so a child's write invalidates the catalog through the ordinary watcher path; this command does no registry work.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, turn extraction, the capture and curation prompts, the `/summarize-skill` handler, the compaction listener |

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

Indirectly, through the summary child: the command's own acknowledgement is human-facing only, while a started subagent receives the capture prompt as its user message through the delegation seam that owns its delivery; the compaction pass starts the same kind of child without any acknowledgement at all.

#### KV Cache effect

Independent of the main conversation: the child is its own session with its own prefix, and the main conversation's request prefix never changes because a capture ran. The compaction pass is deliberate about this — it runs only where the prefix is being rebuilt anyway.

## Known Limitations and Deferred Work

- **Text turns only** — images, files, and tool results in the captured turns are invisible to the child; a workflow that lives in tool call arguments does not survive the excerpt. The automatic pass reads a compaction summary, so it sees even less than the excerpt did.
- **No name control** — the child chooses the kebab-case skill name; a user who wants a specific name edits the file or frontmatter afterward.
- **No completion notice** — the command reports the child id and returns, and the automatic pass reports nothing to anyone; watching a child settle is the subagent surface's job, not this command's.
- **Reflection is bounded by the ownership rule** — only `.dsh` roots are handed over, so a deployment whose skills live in a shared or bundled root gets creation and reflection against its own root alone.
- **Curation is best-effort** — a missed compaction boundary, a dropped concurrent pass, or a child that fails to start simply means that boundary was not curated; nothing retries it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open directions: a curation budget that survives across sessions (today's `inFlight` marker is per-process), and a surface that tells a user a curation ran — deliberately omitted so far, because the point of running at the compaction boundary is that the main line never notices.

</details>

**Runtime invariant:** No companion is published. The command runs no model work of its own and writes nothing; the child owns the skill file through its own write tool, sandbox, and approvals.
