---
description: "The error-reflection-prompt plugin: injects the tool-error reflection document into every system prompt as a capped lessons section."
kind: "package-reference"
---

# @deepseek-ai/dsh-error-reflection-prompt

English | [中文](README.zh.md)

## Summary

Lessons that live only in a file help nobody mid-task. This plugin reads the deployment's tool-error reflection document — the same file `/correct-errors` maintains, by default `<dshHome>/error-reflections.md` — and contributes its capped tail as a system-prompt section (`deployment:error-lessons`), so every agent carries the latest synthesized lessons from past tool failures. An absent or empty document contributes no text.

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

Choose it when past tool failures should inform every future turn — the natural companion to `/correct-errors`. Skip it when lessons must stay per-project or out of the model's context entirely; point `docPath` at nothing the command writes, or do not mount the plugin.

### Set up

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-error-reflection-prompt'
```

| Field | Default | Meaning |
|---|---|---|
| `docPath` | `error-reflections.md` under the Harness home | Reflection document to read; a relative path resolves under `$DSH_HOME` or `~/.dsh` |
| `maxPromptChars` | `6000` | Tail cap on the document text contributed to the prompt |

The document grows by dated sections; the capped tail keeps the newest lessons and cuts on a `## ` heading boundary, so earlier lessons age out of the prompt before they age out of the file.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the section is built; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Filesystem-derived, like the skill catalog.** The section text is a provider evaluated per assembly: it reads the document and returns the capped tail, and an empty result contributes no section. No caching layer, no invalidation protocol — the file is the state.
- **The tail, not the whole file.** The document is append-structured with the newest lessons last, so the capped tail is exactly the freshest material; the heading-boundary cut keeps the oldest included section intact.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, section-text shaping, the `deployment:error-lessons` section registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`/correct-errors`](../command-correct-errors/README.md) — the command that maintains the reflection document this plugin injects.
- [System prompt subsystem](../../../packages/core/system-prompt/README.md) — the section registry this plugin contributes to.

-----

<a id="model-experience"></a>
## Model Experience

### Error-reflection system prompt

#### What the model sees

When the reflection document is non-empty, every request carries the `deployment:error-lessons` section: a fixed header followed by the capped, newest-at-end document tail. An absent or empty document contributes no text.

##### Lessons template

```markdown
Lessons from past tool failures (auto-generated reflections; newest at the end):

<capped reflection-document tail>
```

#### Token effect

At most `maxPromptChars` characters of document text per request, plus the fixed header line, counted once per turn inside the system prompt.

#### KV Cache effect

The section sits at order 100, after the deployment persona and before policy sections. Text changes when the reflection document changes, which shifts the request prefix at the section — acceptable for low-frequency, operator-invoked updates.

## Known Limitations and Deferred Work

- **Global, not per-project.** The default document is one deployment-wide file; per-project lesson stores would need a scoped `docPath` resolution.
- **No freshness marker.** The prompt carries the lessons but not when they were last updated; adding a timestamp header is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open directions: scoped per-project lesson stores resolved from the session's project root, and a freshness marker line so users can tell stale lessons from current ones at a glance.

</details>
