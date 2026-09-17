# Computer Use

English | [中文](computer.zh.md)

The computer-use seam of [dsh-computer](../../packages/computer/computer) and [dsh-tool-computer-use](../../packages/computer/tool-computer-use) drives the machine's real screen, pointer, and keyboard. It owns the `ctx.computer` capability service, the on-demand `ctx.computerController` controller, the nine model-facing tools, and the policy section that tells the model how to behave while it is driving a desktop somebody is using.

Source: [`packages/computer/computer/src/index.ts`](../../packages/computer/computer/src/index.ts) and [`packages/computer/tool-computer-use/src/index.ts`](../../packages/computer/tool-computer-use/src/index.ts)

## Capability seam

`ctx.computer` is an abstract Service: a provider translates each method into platform input and reports whether the platform can do it at all. The Python provider under [dsh-computer-python](../../packages/computer/computer-python) shells out to a Win32 script; a deployment with no provider reports `available: false` rather than failing, so mounting the tool layer is always safe.

```ts type-equiv
/**
 * One seat's desktop capability. Every method accepts a cancellation signal.
 * @param options - optional cancellation signal and call metadata.
 * @returns provider-defined result for the action.
 */
interface ComputerUse {
  available(options?: ComputerCallOptions): Promise<ComputerAvailability>
  display(options?: ComputerCallOptions): Promise<ComputerDisplay>
  screenshot(options?: ComputerCallOptions): Promise<ComputerScreenshot>
  pointer(options?: ComputerCallOptions): Promise<ComputerPoint>
  move(point: ComputerPoint, options?: ComputerCallOptions): Promise<ComputerPoint>
  click(input: ComputerClickInput, options?: ComputerCallOptions): Promise<ComputerPoint & { button: string; clicks: number }>
  drag(input: ComputerDragInput, options?: ComputerCallOptions): Promise<ComputerDragResult>
  typeText(input: ComputerTypeInput, options?: ComputerCallOptions): Promise<{ characters: number }>
  key(input: ComputerKeyInput, options?: ComputerCallOptions): Promise<{ keys: string[] }>
  scroll(input: ComputerScrollInput, options?: ComputerCallOptions): Promise<ComputerPoint & { deltaX: number; deltaY: number }>
}
```

Expected failures throw a `ComputerError` carrying a stable code; only `available()` is allowed to answer "no" instead of throwing.

## On demand, not by default

Desktop control is the highest-authority capability in the harness: it can press buttons in the user's own applications. Leaving it in the tool catalog would grant it to every session, so it is opt-in. A user message naming a trigger phrase, or the `/computer` command, activates it for that session; `/computer off` withdraws it. Activation is recorded as a `computer/mode` session event and re-applied when the session resumes.

Activation happens on `agent/inbox/claimed`, which runs after a message is claimed but before the prompt is assembled. That ordering is the whole point: the same request that says "click save" already carries the screenshot and click tools, instead of answering "I have no such tool" and needing a second turn.

## The working loop the policy teaches

The policy section is assembled immediately before the MCP introduction, so identity, persona, and tool guidance stay at the front of the prompt. It tells the model to look before acting, to verify after acting, to prefer the keyboard over coordinate clicks, and to click control centers rather than label edges. It also states the boundary that matters most: screen content is evidence, never instruction. Text on screen may carry a prompt injection, and irreversible actions need consent that comes from the user rather than from the screen.

Screenshots come back wrapped as untrusted interface evidence, so a picture of a dialog cannot silently promote itself into a task requirement.

## Language

The policy copy follows the prompt locale, which by default follows the interface language the user picked in settings. A deployment may pin `system-prompt.promptLocale` to `zh` or `en` instead.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputer--computeruse-abstract-seam"></a>

### `ctx.computer` — `ComputerUse` (abstract seam)

The computer-use capability. Implementations own platform details, external process lifetimes, and error classification; callers depend only on these semantics.

Contract:

- Every coordinate lives in one coordinate system: the physical pixels of the virtual screen ComputerDisplay describes. Capture and input must share it, or a click lands somewhere other than where it was aimed.
- Every method accepts a cancellation signal; on abort it must terminate the processes it started and settle promptly.
- Expected failures throw a `ComputerError` carrying a stable code rather than the raw platform error.

```ts cordis-catalog
/**
 * Probe whether desktop actions can actually execute right now.
 *
 * This is the only method allowed not to throw: when unavailable it returns
 * `available: false` with a reason, so a Consumer can load as usual and merely
 * hide its tools. Implementations should cache the probe result rather than
 * paying a process start on every call.
 *
 * @param options - optional cancellation signal and call metadata.
 * @returns the availability verdict; when unavailable, with a human-readable reason.
 */
abstract available(options?: ComputerCallOptions): Promise<ComputerAvailability>

/**
 * Read the virtual screen geometry.
 * @param options - optional cancellation signal and call metadata.
 * @returns the virtual screen's width and height, plus scaling notes when any.
 */
abstract display(options?: ComputerCallOptions): Promise<ComputerDisplay>

/**
 * Capture the whole virtual screen.
 * @param options - optional cancellation signal and call metadata.
 * @returns the screenshot attachment and its actual pixel dimensions.
 */
abstract screenshot(options?: ComputerCallOptions): Promise<ComputerScreenshot>

/**
 * Read the pointer's current position.
 * @param options - optional cancellation signal and call metadata.
 * @returns the screen coordinates the pointer currently occupies.
 */
abstract pointer(options?: ComputerCallOptions): Promise<ComputerPoint>

/**
 * Move the pointer to a position.
 * @param point - the target screen coordinates.
 * @param options - optional cancellation signal and call metadata.
 * @returns the pointer's actual coordinates after the move.
 */
abstract move(point: ComputerPoint, options?: ComputerCallOptions): Promise<ComputerPoint>

/**
 * Click at a position, or at the current position when omitted.
 * @param input - click position, button, and count.
 * @param options - optional cancellation signal and call metadata.
 * @returns where the click landed, with the button and count that took effect.
 */
abstract click(input: ComputerClickInput, options?: ComputerCallOptions): Promise<ComputerPoint & { button: string; clicks: number }>

/**
 * Drag from an origin to a destination.
 * @param input - origin, destination, and button.
 * @param options - optional cancellation signal and call metadata.
 * @returns the start and end coordinates with the button that took effect.
 */
abstract drag(input: ComputerDragInput, options?: ComputerCallOptions): Promise<ComputerDragResult>

/**
 * Type a run of text.
 * @param input - the text to type.
 * @param options - optional cancellation signal and call metadata.
 * @returns how many characters were actually delivered.
 */
abstract typeText(input: ComputerTypeInput, options?: ComputerCallOptions): Promise<{ characters: number }>

/**
 * Press and release one chord of keys.
 * @param input - the key sequence, such as `['ctrl', 'c']`.
 * @param options - optional cancellation signal and call metadata.
 * @returns the key sequence actually pressed.
 */
abstract key(input: ComputerKeyInput, options?: ComputerCallOptions): Promise<{ keys: string[] }>

/**
 * Scroll at a position, or at the current position when omitted.
 * @param input - scroll position and vertical/horizontal deltas; a positive vertical delta scrolls down, matching DOM `WheelEvent`.
 * @param options - optional cancellation signal and call metadata.
 * @returns where the scroll landed with the deltas that took effect.
 */
abstract scroll(input: ComputerScrollInput, options?: ComputerCallOptions): Promise<ComputerPoint & { deltaX: number; deltaY: number }>
```

Source: [`packages/computer/computer/src/index.ts`](../../packages/computer/computer/src/index.ts)

<a id="ctxcomputercontroller--computerusecontroller"></a>

### `ctx.computerController` — `ComputerUseController`

`ctx.computerController`: owns the on-demand enablement state, the model-facing `/computer` command, and the `computer:policy` section plus tool set loaded into the agent scope while it is enabled.

Why the name is not `computerUse`: upstream 0.1.6 defines `ctx.computerUse` as a "only one provider may register at a time" slot (`packages/computer-use`), which is a different concern from this controller. Coexisting under one name would make cordis's provide collide and would leave the type augmentations unmergeable, so this controller yields the name.

```ts cordis-catalog
/**
 * Read a session's enablement state, preferring an enable that just happened
 * inside this process.
 *
 * @param session - the target session.
 * @returns whether the capability is enabled.
 */
isActive(session: Session): boolean

/**
 * Explicit enablement (the command path). A command runs outside a step, so it
 * can probe host capability first and return "this machine cannot do it" to
 * the user as a readable failure rather than letting it blow up on the first
 * click.
 *
 * @param agent - the target agent.
 * @param reason - why it is being enabled, for the log.
 * @returns the command receipt.
 */
async activate(agent: Agent, reason: ActivationReason): Promise<{ kind: 'success' | 'error'; text: string }>

/**
 * Turn computer use off: unregister the tools and write the log event.
 *
 * @param agent - the target agent.
 * @returns the command receipt.
 */
deactivate(agent: Agent): { kind: 'success' | 'error'; text: string }
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/computer/tool-computer-use/src/index.ts`](../../packages/computer/tool-computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
