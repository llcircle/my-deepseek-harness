---
description: "The /translate-system-prompt command: a bilingual archive of the exact system prompt the receiving agent assembles, for users reading the workflow in their language and maintainers auditing the deployment."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-translate-system-prompt

English | [中文](README.zh.md)

## Summary

The system prompt a deployment injects is written once, usually in English, and the user never sees it as text — only its effects. `/translate-system-prompt` makes it readable in both languages: the command assembles the receiving agent's exact agent-scoped system prompt, starts ONE background one-shot subagent carrying the rendered text, and the child writes two files: a bilingual markdown archive (default `.dsh/system-prompt.zh.md`) with an `## Original` section and a full `## <locale>` translation, plus a translation-only prompt (default `.dsh/system-prompt.zh.prompt.md`) that `dsh-system-prompt` uses for later assemblies in that project. The command runs no model work itself.

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

Choose it when users should be able to read the deployment's injected workflow in their own language, or when maintainers want a point-in-time record of the exact prompt a session runs. Skip it when you expect automatic re-archiving after every prompt change; this pass runs only when invoked, and the archive is a snapshot, not a live mirror.

### Set up

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-translate-system-prompt'
```

| Field | Default | Meaning |
|---|---|---|
| `archivePath` | `.dsh/system-prompt.zh.md` | Bilingual archive file the child writes; relative to the child's workspace |
| `promptOnlyPath` | `.dsh/system-prompt.zh.prompt.md` | Translation-only system prompt the child writes; relative to the child's workspace |
| `targetLocale` | `zh` | Target locale BCP-47 tag for the translation |
| `provider` | `spawn` | Subagent provider that runs the translation child |

### Running it

Type `/translate-system-prompt` with the session whose prompt you want archived. Outcomes the acknowledgement reports:

- **Empty prompt** — success with `The assembled system prompt is empty; nothing to translate.`; no child starts.
- **Translation started** — success naming the child run id, both output paths, and the target locale; the child writes the files and settles in the background.
- **Missing runtime** — an error naming the absent system-prompt service or subagent runtime, rather than a silent skip.
- **Assembly failure** — an error naming the assembly fault; no child starts.

### Archive shape

```markdown
## Original

<the assembled system prompt, verbatim>

## zh

<the full translation into the locale>
```

`{{variable}}` placeholders, tool names, and code stay untranslated by instruction; everything else is translated whole.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command scopes the archive task; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **The assembled prompt, not the inputs.** The command renders the same assembly the agent loop builds for a turn (`assemble({ agent, scope: agent })` plus `renderPrompt`), so the archive matches what the model actually receives — including scoped sections and interpolated variables — rather than a reconstruction from source files.
- **The outputs are files, not services.** The child writes one bilingual markdown archive and one translation-only prompt; humans and the system-prompt plugin read them at their own pace. The command holds no translation state.
- **User-invoked.** Re-running replaces the archive; the command never merges or versions it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, prompt assembly and rendering, the translation prompt, the `/translate-system-prompt` handler |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [System prompt subsystem](../../../packages/core/system-prompt/README.md) — the assembly service this command renders through.
- [Subagent subsystem reference](../../../docs/subsystems/subagent.md) — the delegation seam that runs the translation child.
- [`/translate-skills`](../command-translate-skills/README.md) — the companion pass that archives skill catalog summaries per locale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the translation child: the command's own acknowledgement is human-facing only, while the started subagent receives the rendered prompt as its user message through the delegation seam that owns its delivery.

#### KV Cache effect

Independent of the main conversation: the child is its own session with its own prefix; the main conversation's request prefix never changes because a translation pass ran.

## Known Limitations and Deferred Work

- **Point-in-time snapshot** — a later prompt change does not update the archive; run the command again to rebuild it.
- **No archive viewer** — the model consumes the translation-only file automatically, but no UI surface reads the bilingual archive; surfacing it in the client is deferred work.
- **Whole-file writes** — the child rewrites the archive in one write; concurrent invocations last-write-wins.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: a client-side reader that shows the archived bilingual prompt in settings.

</details>

**Runtime invariant:** No companion is published. The command only renders the current prompt and hands it to the child; the files the child writes are consumed by `dsh-system-prompt`, which owns the assembly path.
