---
description: "The /translate-skills command: a locale archive of skill summaries (descriptions only), for users reading skills in their language and maintainers composing the pass."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-translate-skills

English | [中文](README.zh.md)

## Summary

Skill descriptions are written in whatever language their author used, so a catalog mixes languages and a reader scanning it fights vocabulary before they ever reach a workflow. `/translate-skills` produces one locale archive: the command reads every catalogued skill's `description` and optional `whenToUse` from `ctx.skills.list()`, starts ONE background one-shot subagent with those summaries and an explicit scope — descriptions only, never skill names, never bodies — and the child writes the translations as one JSON file (default `.dsh/skill-translations.zh.json` in the workspace, keyed by skill name). The command runs no model work itself; bodies stay untouched by construction because they never enter the prompt. `dsh-tool-skill` consumes the archive automatically, so one completed pass makes the session catalog render in Chinese.

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

Choose it when users should be able to refresh a per-locale summary archive on demand — typically after adding or editing skills while reading the catalog in Chinese. Skip it when you expect automatic re-translation on every catalog change; this pass runs only when invoked.

### Set up

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-translate-skills'
```

| Field | Default | Meaning |
|---|---|---|
| `archivePath` | `.dsh/skill-translations.zh.json` | Archive file the child writes; relative to the child's workspace |
| `sharedArchivePath` | `skill-translations.zh.json` under the Harness home | Shared archive the child writes IN ADDITION, so one translation pass covers every workspace; an empty string disables the shared copy |
| `targetLocale` | `zh` | Target locale BCP-47 tag for the translations |
| `provider` | `spawn` | Subagent provider that runs the translation child |
| `childTools` | `["read", "write"]` | Tools this child keeps; every other inherited tool is removed. An empty list leaves its tool set untouched |
| `childOmitSections` | `["harness:identity", "deployment:persona-prefix", "deployment:error-lessons"]` | Prompt sections this child does not get |

### Running it

Type `/translate-skills` with the session opened in the project whose skills you want archived. Outcomes the acknowledgement reports:

- **Empty catalog** — success naming the workspace with `No skills catalogued for <cwd>; nothing to translate.`; no child starts.
- **Translation started** — success naming the child run id, the archive path, the skill count, and the target locale; the child writes the JSON and settles in the background.
- **Missing runtime** — an error naming the absent skill registry or subagent runtime, rather than a silent skip.

### Archive shape

```json
{ "deploy-docs": { "description": "<translated>", "whenToUse": "<translated or omitted>", "promptLine": "- \`deploy-docs\`: <translated description>" } }
```

Every key is the untranslated skill name; `whenToUse` is omitted when the source summary carries none, and `promptLine` archives the translated system-prompt catalog line. `dsh-tool-skill` reads `description` from this archive automatically and renders the whole catalog in Chinese once at least one translation exists.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command scopes the translation task; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Summaries only, by construction.** The prompt is built from `toSummaryEntry()`, which keeps exactly `name`/`description`/`whenToUse` and drops everything else — there is no path a skill body could take into the prompt, so the "never translate bodies" rule is structural, not an instruction the model might disobey.
- **The agent-scoped catalog.** The handler resolves the skill registry through the agent's preset mount (`presets.serviceFor(agent, 'skills')`) with the app-level registry as a test-only fallback — the filesystem-backed catalog lives on the agent scope, and the bare app-level registry lists nothing.
- **The archive is a file, not a service.** The child writes one JSON document; `dsh-tool-skill` reads it per catalog publication, and future UI surfaces can read it at their own pace. The command itself holds no translation state.
- **User-invoked.** Re-running replaces the archive wholesale; the command never merges or de-duplicates.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, summary extraction, the translation prompt, the `/translate-skills` handler |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the provider registry and catalog this command reads.
- [Subagent subsystem reference](../../../docs/subsystems/subagent.md) — the delegation seam that runs the translation child.
- [Skill group map](../README.md) — the sibling skill packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the translation child: the command's own acknowledgement is human-facing only, while the started subagent receives the summary listing as its user message through the delegation seam that owns its delivery.

#### KV Cache effect

Independent of the main conversation: the child is its own session with its own prefix; the main conversation's request prefix never changes because a translation pass ran.

## Known Limitations and Deferred Work

- **Archive-wide activation** — one valid description switches catalog framing to Chinese; entries without a translation fall back to their original description.
- **Manual refresh** — editing a skill does not re-translate; run the command again to rebuild the archive.
- **Whole-file writes** — the child rewrites the archive in one write; concurrent invocations last-write-wins.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: a client-side reader that overlays archived summaries onto skill menus when the UI locale matches.

</details>
