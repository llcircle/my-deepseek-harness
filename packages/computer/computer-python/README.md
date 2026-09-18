---
description: "The Python/Win32 desktop-control provider: drives screen capture and pointer/keyboard input through a standard-library-only CPython runtime, for users and maintainers enabling or debugging desktop control on Windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-python

English | [中文](README.zh.md)

## Summary

`dsh-computer-python` implements `ctx.computer` on Windows by driving the real desktop through a small standard-library Python script. It captures the whole virtual screen with GDI, encodes PNG with `zlib`, and sends pointer and keyboard input through `SendInput`, all via `ctypes` — no third-party package, no compiler, no native addon. It ships with [`dsh-tool-computer-use`](../tool-computer-use/README.md), which decides when the model may use it. Choose it when the agent should operate a Windows desktop and you would rather not ship a native binary; skip it on other platforms, where it reports an honest reason instead of failing later.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside a consumer that turns the seam into tools.

```yaml
- name: '@deepseek-ai/dsh-computer-python'
```

| Field | Default | Meaning |
|---|---|---|
| `pythonPath` | `''` | CPython interpreter (absolute path or PATH name). Empty probes `python`, then `python3`, then `py -3`, keeping the first that answers a probe call. |
| `timeoutMs` | `20000` | Per-action deadline. Screenshots include PNG encoding, so do not set this too low. |

Nothing starts at mount time. The interpreter probe runs on the first real call (or the first `available()`), so a deployment without a desktop pays nothing for having the plugin loaded. A failed probe is cached: install Python and restart rather than expecting a later call to retry.

### Why an external Python process

Node has no built-in Win32 binding, and every alternative was worse here: a native addon needs a compiler on the user's machine, and a screenshot tool is not something Windows ships on the command line. `ctypes` is part of CPython's standard library, so the whole provider becomes "a script plus an interpreter" — and the platform detail stays inside one file that a macOS or Linux provider can replace without touching the seam or the tools.

The provider does **not** go through `ctx.subprocess`. That seam follows the configured execution world, which may be a remote sandbox, while a desktop action has to land on the machine the user is looking at.

### The runtime protocol

`runtime/computer_agent.py` reads one JSON request from stdin and writes one JSON reply to stdout. Requests name an action (`screenshot`, `display`, `pointer`, `move`, `click`, `drag`, `type`, `key`, `scroll`) plus its fields; replies are `{ ok: true, ... }` or `{ ok: false, error, code }`. The action set is a whitelist, arguments never touch a shell, and the process always exits 0 — a crash and a refused action must not look alike to the caller.

UTF-8 text input goes through `KEYEVENTF_UNICODE`, which delivers character codes directly and therefore works for Chinese and emoji without depending on the active keyboard layout.

### Coordinates and DPI

The script calls `SetProcessDPIAware()` at startup, so GDI capture and `SendInput`/`SetCursorPos` agree on the same physical-pixel coordinate system. Without it, a scaled display reports logical pixels to capture but accepts them as physical input — the failure mode is clicks landing at half the intended distance, which looks like a model error rather than an integration bug.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-computer`](../computer/README.md) — the seam this implements, including the coordinate contract.
- [`dsh-tool-computer-use`](../tool-computer-use/README.md) — the consumer that decides when the model may act.
- [`dsh-native-command`](../../util/native-command/README.md) — the shared no-shell host command boundary this provider deliberately does not use.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-computer-use`, which owns the tool schemas and guidance the model sees; this provider contributes no prompt text or schema of its own.

#### KV Cache effect

No direct invalidation; only the named consumer's section and schemas can change a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Windows only.** Other platforms get `available(): false` with a reason; a macOS provider would use `CGEvent`/`screencapture` and a Linux one X11 or Wayland capture, behind the same interface.
- **One process per action.** Simple and stateless, at roughly a hundred milliseconds of interpreter start per call. A resident session would cut that, at the cost of lifecycle and crash-recovery complexity this package does not yet carry.
- **Screenshots are the whole virtual screen.** No region capture, no window targeting; a multi-monitor desktop produces one wide image.
- **No verification that an action did anything.** The seam reports that input was delivered, not that the target application responded. Confirming an outcome means capturing the screen again.
- **Requires a desktop session.** A Windows service or an SSH session without an interactive desktop reports unavailable rather than returning black frames.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The runtime is a standalone script (`runtime/computer_agent.py`) spoken to as JSON lines over stdio. The Node side never imports Python and never links against it — that boundary is what keeps the provider free of third-party dependencies on the JS side.
- Two defects only a real desktop could surface, both fixed at the wire boundary: the drag tool never reached its start point (the parameter names did not match the generic parser), and vertical wheel direction was inverted (Win32 `MOUSEEVENTF_WHEEL` counts positive as scrolling up). The sign flip now carries a comment, because the external contract follows `WheelEvent`, not Win32.

</details>

**Runtime invariant:** No companion is published. Each action runs as a one-shot process and leaves no durable package-local state behind; only the consumer records enablement.
