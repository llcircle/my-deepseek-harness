---
description: "The desktop-control capability seam: screen capture, pointer, and keyboard input behind one swappable provider interface, for users and maintainers adding or replacing how the agent reaches a real desktop."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer

English | [中文](README.zh.md)

## Summary

`dsh-computer` declares `ctx.computer`: one interface for looking at and acting on a real desktop — read the screen, move and click the pointer, type text, press keys, scroll. It ships no implementation and no model-facing tool: a provider implements the interface on some platform, and a consumer (the shipped `dsh-tool-computer-use`) turns it into tools. Choose it when a deployment needs desktop control and you want the platform detail replaceable; skip it when nothing reaches a desktop.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a provider, not this package alone: this package only declares the seam. The shipped provider is [`dsh-computer-python`](../computer-python/README.md), which drives Windows through a standard-library Python runtime; the shipped consumer is [`dsh-tool-computer-use`](../tool-computer-use/README.md), which exposes the tools on demand.

### The contract

Every coordinate in this seam lives in one coordinate system: the physical pixels of the virtual screen that [`ComputerDisplay`](#the-contract) describes. Capture and input must share it, or a click lands somewhere other than where the model looked. A provider that violates this is not merely inaccurate — it is dangerous, because the model's only feedback loop is "act, then look again".

`available()` is the one method that reports instead of throwing: it answers whether this host can act at all, so a consumer can load normally and simply hide its tools where no desktop exists. Implementations cache the probe, because the answer costs a process start.

Expected failures carry a stable `ComputerErrorCode`, never a platform error message the caller must parse; `ABORTED` and `TIMEOUT` are separate from real action failures so a caller can tell "the user stopped this" from "this did not work".

### Writing a provider

Implement the abstract class, load the class as a plugin (it registers as `ctx.computer`), and keep every platform-specific decision inside it. Two obligations are easy to miss:

- **Forward the abort signal into whatever you spawn**, and terminate that work when it fires. The seam promises a caller that cancellation reaches quiescence.
- **Do not route through `ctx.subprocess`**. That seam belongs to the configured execution world, which may be a remote sandbox; a desktop action has to happen where the user is actually looking. Reaching the host directly is exactly why this capability is deliberately opt-in.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-computer-python`](../computer-python/README.md) — the shipped Windows provider.
- [`dsh-tool-computer-use`](../tool-computer-use/README.md) — the shipped model-facing consumer, including the on-demand activation rule.
- [Where new behavior goes](../../../docs/architecture.md#where-new-behavior-goes) — why a model-facing capability registers on `ctx.tools` and a platform capability gets a seam.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package declares only the seam's provider operations and registers no prompt text, tool schema, or session event of its own.

#### KV Cache effect

The seam contributes no tokens; only the consumer's section and schemas can change a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Windows only, through the shipped provider.** The seam itself is platform-neutral, but nothing implements macOS or Linux yet; `available()` reports an honest reason there rather than failing at the first click.
- **No accessibility tree.** The model locates targets by looking at pixels. That is the difference between "click at (640, 400)" and "click the Save button", and it is the main source of brittleness on unfamiliar UIs.
- **No screenshot-region or window targeting.** Every capture is the whole virtual screen; a multi-monitor setup sends one wide image.
- **No per-action approval wiring.** A deployment that wants confirmation before destructive clicks must add it through `tools/pre-execute`; this seam does not decide policy.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The seam is deliberately provider-agnostic: nothing in `src/` names Windows. A new platform provider implements `ComputerUse` and needs no change here; `available()` must report a reason instead of throwing, because that is what lets a deployment mount a provider unconditionally.
- The shipped pair is `dsh-computer-python` (provider) + `dsh-tool-computer-use` (consumer). Both are separate packages so a deployment can replace either half.

</details>

**Runtime invariant:** No companion is published. The package owns only an interface and a provider registry: a provider holds every platform fact, so no durable package-local relation exists to cross-check.
