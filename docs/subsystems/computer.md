# Computer Use

English | [中文](computer.zh.md)

The computer-use seam of [dsh-computer](../../packages/computer/computer) and [dsh-tool-computer-use](../../packages/computer/tool-computer-use) drives the machine's real screen, pointer, and keyboard. It owns the `ctx.computer` capability service, the on-demand `ctx.computerUse` controller, the nine model-facing tools, and the policy section that tells the model how to behave while it is driving a desktop somebody is using.

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

电脑操作能力。实现类负责平台细节、外部进程生命周期与错误归类； 调用方只依赖这组语义。

契约：

- 所有坐标处于同一坐标系：ComputerDisplay 描述的虚拟屏幕物理像素。 截图与输入必须共用它，否则点击会落在错误的位置。
- 每个方法都接受取消信号；中止时必须终止自己启动的进程并尽快 settle。
- 预期失败抛出带稳定 code 的 `ComputerError`，不抛出平台原始错误。

```ts cordis-catalog
/**
 * 探测当前是否真的可以执行桌面动作。
 *
 * 这是唯一允许"不抛错"的方法：不可用时返回 `available: false` 与原因，
 * 让 Consumer 可以照常加载并只隐藏工具。实现应缓存探测结果，
 * 避免每次调用都付出一次进程启动代价。
 *
 * @param options - 可选的取消信号与调用元数据。
 * @returns 可用性判定；不可用时带一句给人看的原因。
 */
abstract available(options?: ComputerCallOptions): Promise<ComputerAvailability>

/**
 * 读取虚拟屏幕几何。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 虚拟屏幕的宽高与（如有）缩放说明。
 */
abstract display(options?: ComputerCallOptions): Promise<ComputerDisplay>

/**
 * 截取整个虚拟屏幕。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 截图附件与它的实际像素尺寸。
 */
abstract screenshot(options?: ComputerCallOptions): Promise<ComputerScreenshot>

/**
 * 读取指针当前位置。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 指针当前所在的屏幕坐标。
 */
abstract pointer(options?: ComputerCallOptions): Promise<ComputerPoint>

/**
 * 把指针移动到指定位置。
 * @param point - 目标屏幕坐标。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 移动后指针的实际坐标。
 */
abstract move(point: ComputerPoint, options?: ComputerCallOptions): Promise<ComputerPoint>

/**
 * 在指定位置（省略则用当前位置）点击。
 * @param input - 点击位置、按键与次数。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 点击落点与生效的按键、次数。
 */
abstract click(input: ComputerClickInput, options?: ComputerCallOptions): Promise<ComputerPoint & { button: string; clicks: number }>

/**
 * 从起点拖拽到终点。
 * @param input - 起点、终点与按键。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 起止坐标与生效的按键。
 */
abstract drag(input: ComputerDragInput, options?: ComputerCallOptions): Promise<ComputerDragResult>

/**
 * 输入一段文本。
 * @param input - 待输入的文本。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 实际送入的字符数。
 */
abstract typeText(input: ComputerTypeInput, options?: ComputerCallOptions): Promise<{ characters: number }>

/**
 * 按下并释放一组组合键。
 * @param input - 组合键序列，如 `['ctrl', 'c']`。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 实际按下的键序列。
 */
abstract key(input: ComputerKeyInput, options?: ComputerCallOptions): Promise<{ keys: string[] }>

/**
 * 在指定位置（省略则用当前位置）滚动。
 * @param input - 滚动位置与纵向/横向位移；纵向正数向下，与 DOM `WheelEvent` 一致。
 * @param options - 可选的取消信号与调用元数据。
 * @returns 滚动落点与生效的位移。
 */
abstract scroll(input: ComputerScrollInput, options?: ComputerCallOptions): Promise<ComputerPoint & { deltaX: number; deltaY: number }>
```

Source: [`packages/computer/computer/src/index.ts`](../../packages/computer/computer/src/index.ts)

<a id="ctxcomputeruse--computerusecontroller"></a>

### `ctx.computerUse` — `ComputerUseController`

`ctx.computerUse`：拥有按需启用状态、面向模型的 `/computer` 命令， 以及启用期间装载到 agent 作用域的 `computer:policy` 策略分节与工具集。

```ts cordis-catalog
/**
 * 读取会话的启用状态，优先返回本进程内刚发生的启用。
 *
 * @param session - 目标会话。
 * @returns 是否启用。
 */
isActive(session: Session): boolean

/**
 * 显式启用（命令路径）。命令在步进之外运行，因此可以先探测宿主能力，
 * 把"这台机器不能用"作为可读的失败返回给用户，而不是留到第一次点击才炸。
 *
 * @param agent - 目标 agent。
 * @param reason - 启用原因，用于日志。
 * @returns 命令回执。
 */
async activate(agent: Agent, reason: ActivationReason): Promise<{ kind: 'success' | 'error'; text: string }>

/**
 * 关闭电脑操作：注销工具并写入日志事件。
 *
 * @param agent - 目标 agent。
 * @returns 命令回执。
 */
deactivate(agent: Agent): { kind: 'success' | 'error'; text: string }
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/computer/tool-computer-use/src/index.ts`](../../packages/computer/tool-computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
