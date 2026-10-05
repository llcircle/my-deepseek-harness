---
description: "The model-facing skill loader and its per-turn BM25 retrieval list for users and maintainers understanding what agents see, or configuring which skills one request is scored against."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

English | [中文](README.zh.md)

## Summary

Agents can discover and load skills mid-session. At each turn's first step the plugin scores the user's own text against every model-invocable skill with BM25 and appends the winners to that step's messages; the `skill` tool then loads any skill by exact name, including one the list did not name. Users can invoke a user-invocable skill with `/name`, which injects the same instructions into that step. `retrievalMaxResults` caps the list, `catalogDescriptionMaxLength` caps each description, and `catalogLocale` selects the framing language.

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

Mount the plugin alongside the skill registry to give agents a per-turn skill list and the `skill` loader tool. It requires `ctx.agents`, `ctx.tools`, `ctx.skills`, and `ctx.systemPrompt`.

### When to choose it

Use it when agents should discover and load skills during a session. Skip it when skill loading is handled by another consumer or not needed at all — without it, providers and the registry still work, but nothing names skills to the model and no tool loads them.

### Mount and configure

Load the plugin together with the skill registry and at least one provider. The configuration caps how wide the list may be and how long each description may read, and selects the list locale.

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| Field | Default | Meaning |
|---|---|---|
| `retrievalMaxResults` | `5` | Maximum skills one turn's list may name; minimum 1 |
| `catalogDescriptionMaxLength` | `500` | Maximum normalized description length rendered in the list; minimum 3 |
| `catalogLocale` | `auto` | `auto` follows the active prompt language; `zh` always uses Chinese framing; `en` never translates |
| `catalogTranslationsFile` | `.dsh/skill-translations.zh.json` | Per-project translation archive; relative paths resolve against the session workspace |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-skill) is the exhaustive source for every accepted field.

### What the model gets

- **A per-turn retrieval list.** On a turn's first step, when model-invocable skills exist and this exact `skill` tool is visible, the direct user text of that step is scored against every skill's name and description with BM25, and the top `retrievalMaxResults` are appended to the step's messages as one `<available_skills>` reminder that also states how many skills the session holds in total. In the default `auto` locale one translated description makes the framing Chinese; untranslated entries fall back to their original description.
- **A loader tool.** The model calls `skill` with the exact skill name and receives the full instruction body plus resource guidance in a canonical `<skill_content>` block; the result is retained as ordinary tool history. The tool resolves any name the registry holds, so a name the list never mentioned still loads — and the list says so.
- **Explicit user invocation.** A `/name` token in direct user input that names a user-invocable skill injects that skill's instructions into the step, without the model having to load it.
- **One list per turn.** Later steps of the same turn reuse the list already in context; the next turn's list says it supersedes the earlier one, so a name that dropped out of the selection is retired without an empty replacement.

### Observable success and failures

Loading a listed or unlisted skill returns its full instructions; the model sees one canonical shape whether the load came from the tool or from a user's explicit invocation. An invalid name reports `Error: invalid skill name "<name>"`, an unknown name reports the skill is unknown or no longer available, and a skill disabled for model invocation reports it is not available for model invocation. Nothing is appended when the step carries no direct user text, when the step's batch is empty, when the registry returns an incomplete snapshot, when no model-invocable skill exists, or when the `skill` tool is hidden or shadowed by a same-name scoped tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the retrieval list and the invocation boundary are built; the observable behavior is fully covered in [Use this package](#use-this-package) and the Model Experience section below.

### Design concept

Two ideas carry the package. First, the list is *re-derived from the request on every turn* rather than maintained as a durable document: scoring is a pure function of the user's text and the live registry, so there is no digest to compare, no replacement to publish, and no stale name to retire explicitly. Second, one canonical rendering serves both load paths — the tool result and the user-explicit injection — through `renderSkillContent` shared from `dsh-skill`, so the model sees the same `<skill_content>` shape regardless of who initiated the load.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, retrieval and gesture pre-step listeners, BM25 ranking call, rendering |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream; execution relations are owned by the capability seam it calls. |

### Retrieval lifecycle

At the first step of every turn the plugin returns the batch untouched unless it carries direct user text, confirms that the exact `skill` tool it registered is still visible, snapshots the calling session's skill catalog, and — only on a complete snapshot — ranks every model-invocable skill against the joined user text. The winners are rendered into one `<system-reminder>` message, sourced `{ kind: 'plugin', plugin: 'dsh-tool-skill', form: 'catalog' }`, and appended to the step's messages after every other injection of that step. Later steps of the turn inject nothing: the first list is still in context. The visibility check compares against the exact tool definition this plugin registered, so a scoped same-name shadow removes both the schema and the list; the plugin works mounted globally or inside one agent's composition.

### Invocation boundary

The `/name` gesture listener scans only claimed user messages: a whitespace-bounded token naming a user-invocable skill in the workspace catalog injects the same `<skill_content>` rendering as a `user`-role instructions context. It registers before the retrieval listener, so a step that both names a skill and retrieves a list ends with the injected body last — background first, the material to act on closest to the answer. Unknown names and user-disabled skills stay ordinary prose. This is the only entry point for `disable-model-invocation` skills, which the retrieval list and the `skill` tool never expose.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry vocabulary behind the ranking inputs to the exact tool schema and the design rationale.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider vocabulary the list is ranked over.
- [skill package](../skill/README.md) — the registry, the BM25 ranking primitive, and the shared `renderSkillContent` rendering.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill) — the exact `skill` schema the model receives.
- [User-explicit skill invocation Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md) — the `/name` gesture design.

-----

<a id="model-experience"></a>
## Model Experience

### Retrieval list

#### What the model sees

On a turn's first step, if model-invocable skills exist and this exact `skill` tool is visible, the step's batch gains the reminder below as its last message, with one data-dependent entry per ranked skill and a header stating how many skills the session holds in total. The block is not durable state: the next turn appends a fresh list that declares itself the successor, so a name that dropped out of the selection is retired by that successor rather than by an explicit empty replacement. Two closing sentences carry the safety rules — the list holds summaries only, and it is a selection rather than the whole catalog, so an unlisted skill is still loadable by name. The Chinese locale translates this framing and every archived description while retaining the XML tags, skill names, and tool name.

##### Retrieval list template

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. These are the skills most relevant to the current request (this session holds <total> in total; <listed> listed here). This list supersedes any earlier skill list:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This list contains summaries only; do not infer or follow a skill's instructions until it has been loaded. The list is a selection, not the whole catalog — a skill it does not mention can still be loaded by name.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token effect

Repeated input cost is bounded by `retrievalMaxResults` and `catalogDescriptionMaxLength` rather than by the size of the registry: one list per turn, however many steps that turn takes. No tokens are added when the step carries no direct user text, when the selection is empty, or when the tool is hidden or shadowed.

#### KV Cache effect

The list is appended inside the step's message batch, after the reusable request prefix, so a changed selection never rewrites earlier tokens. Because one turn appends one list, the retained cost is one message per turn rather than one per step.

### Tool schema

#### What the model sees

The model sees the generated [`skill` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-skill).

#### Token effect

Fixed schema cost per request where the tool is visible.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged. Shadowing, restrictions, or plugin lifecycle changes may invalidate reuse from this schema.

### Tool result

#### What the model sees

A successful call uses the result template and the provider-managed, directory, URL, or opaque resource guidance below.

##### Skill result template

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### Provider-managed resource guidance

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### Directory resource guidance

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL resource guidance

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### Opaque resource guidance

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token effect

Loaded instructions are data-dependent tool-result tokens, resent on later steps until compaction; no duplicate `agent.inject()` copy is made.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Invalid or stale selections return exactly `Error: invalid skill name "<name>"`, `Error: skill "<name>" is unknown or no longer available`, or `Error: skill "<name>" is not available for model invocation`. Provider-thrown lookup text is data-dependent and receives the same `Error: <message>` wrapper.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### User-explicit invocation injection

#### What the model sees

A whitespace-bounded `/name` token anywhere in a claimed user message, naming a user-invocable skill in the workspace catalog, injects that skill's full `<skill_content>` rendering (the exact result-template shape above) as a `user`-role instructions context appended after every other injection of that step — background first, the material to act on last, after the retrieval list the same step may have appended. Only direct user input is scanned, the check runs on the loaded definition, and unknown or user-disabled names stay ordinary prose. This is the sole entry point for `disable-model-invocation` skills, which the retrieval list and the `skill` tool never expose; the list's closing sentence tells the model to follow the injected block instead of re-loading it.

#### Token effect

Each gesture adds one rendered skill body to that turn as injected context — the same size as the tool result for the same skill, paid deterministically at the user's request instead of at the model's discretion. Repeated gestures for one skill within one step inject once.

#### KV Cache effect

Append-only; the injection lands after the reusable request prefix inside the step's message batch and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the retrieval list or the loader is a poor fit. They are current package constraints, not a task backlog.

- **Retrieval can miss** — the list names at most `retrievalMaxResults` skills chosen by lexical BM25 over names and descriptions, so a skill whose wording does not match the request is absent from the list and has to be loaded by exact name.
- **Scoring reads only direct user text** — tool results, injected context, and relayed messages never participate, so a task described entirely in a tool result produces no list at all.
- **The list omits `whenToUse`, source, and provider metadata** — routing is based only on name and a capped description; `whenToUse` remains provider metadata and is not rendered by the loaded wrapper either.
- **Loaded instruction bodies have no size cap** — a provider can return a skill large enough to consume substantial next-step context; only listed descriptions are truncated.
- **Resources are guidance, not attachments** — the tool reports a base directory/URL/opaque hint but neither enumerates nor fetches referenced files for the model.
- **Loading is one-shot text** — there is no partial, streaming, or cached-content handle when a remote provider is slow or a skill body is large.
- **Bodies are not versioned** — a body-only edit changes neither the ranking inputs nor the list, so nothing announces it; a later tool call reads the current provider content while earlier tool results remain historical facts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
