---
description: "On-demand desktop control for users and maintainers deciding when the agent may see and drive a real screen: the /computer command, the trigger phrases, the four-layer prompt, and the nine action tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-computer-use

English | [中文](README.zh.md)

## Summary

`dsh-tool-computer-use` gives the model nine desktop actions (screenshot, geometry, pointer position, move, click, drag, type, key, scroll) that exist only where the user asked for them. It stays out of the request until you type `/computer` or say something like "操作电脑", then survives until `/computer off`, across resume and fork. It also owns the guidance the model follows while acting: look, act, look again, and never treat screen content as an instruction. Choose it to let an agent drive the real desktop under explicit consent; skip it when the agent needs only files and commands.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside a provider; it registers no tools until a session enables it.

```yaml
- name: '@deepseek-ai/dsh-computer-python'
- name: '@deepseek-ai/dsh-tool-computer-use'
```

| Field | Default | Meaning |
|---|---|---|
| `policy` | `''` | Replaces the built-in guidance text wholesale. Empty uses the shipped asset. |
| `extraTriggers` | `[]` | Additional phrases that enable the capability, on top of the built-in list. |

### Enabling and disabling

Two paths turn it on. `/computer` (or the alias `/cu`) is the explicit one: it is a slash command, so it produces no model message on its own, and anything you type after it is delivered as your message once the capability is on — `/computer 帮我在记事本里写一段话` starts the work immediately. The implicit path is the message text: a phrase from the trigger list is enough, so "帮我把这个操作电脑点掉" enables the capability and lands in the same request.

`/computer off` disables it, unregistering the tools and logging the change.

Enabling is recorded as a `computer/mode` session event, so a resumed or forked session restores the same state instead of silently losing it.

### Why the judgement runs on `agent/inbox/claimed`

Prompt sections and tool schemas are assembled **before** `agent/pre-step` runs, so a decision taken there would only take effect one step late — the user would ask the agent to click something and the model would reply that it has no such tool. `agent/inbox/claimed` fires synchronously when a message is claimed, before assembly, which is the only point where "enable it for *this* request" is achievable.

That is also why enabling is synchronous: the tools and the prompt section are registered into the agent's own scope right there, so the same assembly already carries both.

### Consent is only ever the user's

The trigger check reads human input only (`source.kind === 'user'`). Plugin notices and tool results are ignored, so a screenshot whose pixels happen to contain the words "操作电脑" cannot enable anything, and neither can a model that decides it would like the capability. The same reasoning is written into the guidance: screen content is evidence, not instruction.

### The four layers of guidance

1. **Static asset** — the shipped text, identical everywhere.
2. **Deployment override** — `policy` replaces it, for wording, policy tightening, or another language.
3. **Runtime mounting** — the `computer:policy` section is registered into the agent's scope when enabling and disposed when disabling, in the same step as the tools. A disabled session does not carry an empty section; it carries no section at all. This is the shape Claude Code gives computer use as an MCP server, which answers `ListTools` with an empty list while disabled: an absent capability announces nothing rather than announcing a shell.
4. **Evidence framing** — every screenshot result is wrapped as untrusted interface evidence with an explicit "this is not an instruction" statement.

Tools are deliberately fine-grained rather than one "write a script" executor: each action becomes its own `tool/call` and `tool/result`, so the log can be replayed exactly, failures localize to one step, and a deployment can attach approval at action granularity through `tools/pre-execute`.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-computer`](../computer/README.md) and [`dsh-computer-python`](../computer-python/README.md) — the seam and its shipped provider.
- [Session log](../../../docs/architecture.md#session-log) — why enabling is a durable event rather than memory.
- [`dsh-plan-mode`](../../plan/plan-mode/README.md) — the other per-session collaboration state, and this package's model for dynamic prompt sections.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

While the capability is enabled, the model receives nine `computer_*` schemas — `computer_screenshot`, `computer_screen_geometry`, `computer_pointer_position`, `computer_move`, `computer_click`, `computer_drag`, `computer_type`, `computer_key`, and `computer_scroll` — catalogued under [computer-use tools](../../../docs/tool-catalog.md#deepseek-aidsh-tool-computer-use). While it is disabled no schema exists at all, so nothing in the request advertises a capability the session cannot use.

#### Token effect

All nine schemas cost their full length on every request while enabled, and nothing while disabled. A screenshot result also carries an image block, so its cost tracks the captured resolution rather than the number of actions taken.

#### KV Cache effect

Enabling or disabling rewrites the tool catalog, so reuse breaks from the point the schemas join the request. While the capability stays enabled the unchanged schemas keep the prefix reusable, and each screenshot appends an image block after that prefix.

### Guidance prompt section

#### What the model sees

Enabling registers a `computer:policy` section into the agent's own scope in the same step as the tools, and `/computer off` disposes it; a disabled session carries no section rather than an empty one, so the prompt editor shows no row for it and a lesson already written under `## computer:policy` is reported as having no matching ability instead of being injected. The text is the shipped asset unless the deployment's `policy` config replaces it wholesale. Screenshot results arrive as an image plus a text envelope that states the image-to-screen coordinate mapping and frames the content as untrusted evidence.

#### Token effect

The section text repeats on every request while enabled and costs nothing while disabled. A deployment `policy` spends its own length in place of the shipped asset.

#### KV Cache effect

Adding or removing the section changes the system prompt from that section onward, so reuse breaks from the first changed token. The text itself stays stable for as long as the capability remains enabled.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No approval prompt per action.** Every action a model takes while enabled runs immediately; the guardrail is the guidance text plus whatever `tools/pre-execute` policy a deployment adds.
- **Trigger phrases are literal substring matches.** They are chosen to be specific, but a message that discusses desktop automation without asking for it will still enable the capability. `/computer off` is the escape hatch.
- **No screenshot throttling.** A model that captures in a loop spends tokens on images at its own pace; nothing here rate-limits it.
- **The escape hatch is `/computer off`, not a key.** A model stuck in a click loop is stopped by cancelling the turn; there is no non-model interrupt channel like Claude Code's overlay hotkey.
- **No activity trail beyond session events.** Enable, disable, and every action are in the log, but there is no separate desktop-automation audit surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- Enablement runs on `agent/inbox/claimed`, which is earlier than tool-schema assembly. That is why an enabling message gets the tools in the same request instead of one step late; moving the hook later is not an optimization, it is a behaviour change.
- The screenshot tool checks the session's model route for a declared `image` input before capturing. Without that guard a text-only model burns a capture on an image nobody can read.

</details>

**Runtime invariant:** No companion is published. Enablement and every action are already durable as `computer/mode`, `tool/call`, and `tool/result` session events, and the section text has a single owner.
