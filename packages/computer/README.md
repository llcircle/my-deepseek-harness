---
description: "The computer group map: the desktop-control seam, its Windows provider, and the on-demand tool consumer, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/computer

English | [中文](README.zh.md)

## Summary

The computer group lets an agent see and drive the user's real desktop — capture the screen, move and click the pointer, type, press keys, scroll — but only where the user asked for it. It is three packages forming one capability: a seam declaring what desktop control means, a Windows provider that implements it through a standard-library Python runtime, and a consumer that turns it into nine fine-grained tools and enables them on demand. Enabling is per session and recorded in the log, so a resumed session keeps the same state.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`computer`](computer/README.md) | Declares the desktop-control seam: display geometry, capture, pointer, and keyboard as one replaceable interface | `ctx.computer` |
| [`computer-python`](computer-python/README.md) | Implements the seam on Windows through a standard-library CPython runtime driven over a JSON line protocol | provides `ctx.computer` |
| [`tool-computer-use`](tool-computer-use/README.md) | Contributes the nine model-facing tools, the `/computer` command, the trigger phrases, and the four-layer guidance, enabled per session | registers on `ctx.tools` (agent scope) |

-----

<a id="related-documentation"></a>
## Related documentation

- [Computer](../../docs/subsystems/computer.md) — the seam's contract, why activation is on demand, and the language the tools follow.
- [Capability seams](../../docs/capability-seams.md) — why a platform capability is a Service Definition, a provider, and a consumer rather than one tool package.
- [Tool execution pipeline](../../docs/tool-execution-pipeline.md) — where an action-level approval would attach.
- [Session log](../../docs/architecture.md#session-log) — why enabling is a durable event.

-----

<a id="dev-note"></a>
## Dev Note

The seam exists because desktop control is unusually platform-bound and unusually privileged: `CGEvent` on macOS, X11 or Wayland on Linux, and a completely different privacy model on each. Keeping the interface free of Win32 vocabulary is what makes a second provider a package rather than a fork.

The group deliberately does **not** expose a coarse "run this automation script" tool. Every action is its own logged `tool/call` and `tool/result`, which keeps the "model-visible means logged" invariant intact and lets policy attach at action granularity. The cost is more tokens per step; that trade was made knowingly, and the reasoning is recorded in [`tool-computer-use`](tool-computer-use/README.md).
