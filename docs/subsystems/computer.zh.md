# 电脑操作

[English](computer.md) | 中文

[dsh-computer](../../packages/computer/computer) 与 [dsh-tool-computer-use](../../packages/computer/tool-computer-use) 的电脑操作能力直接驱动机器真实的屏幕、指针与键盘。它拥有 `ctx.computer` 能力服务、按需启用的 `ctx.computerUse` 控制器、九个面向模型的工具，以及那段告诉模型"你正在操作别人的桌面时该如何行事"的策略分节。

源码：[`packages/computer/computer/src/index.ts`](../../packages/computer/computer/src/index.ts) 与 [`packages/computer/tool-computer-use/src/index.ts`](../../packages/computer/tool-computer-use/src/index.ts)

## 能力 seam

`ctx.computer` 是一个抽象 Service：提供方把每个方法翻译成平台输入，并报告该平台到底能不能做。[dsh-computer-python](../../packages/computer/computer-python) 下的 Python 提供方会调起一段 Win32 脚本；没有提供方的部署返回 `available: false` 而不是报错，因此装载工具层永远是安全的。

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

预期内的失败抛出带稳定 code 的 `ComputerError`；只有 `available()` 允许以"不行"作答而不是抛错。

## 按需启用，而不是默认授予

桌面控制是 harness 里权限最高的一项能力：它能按下用户自己应用里的按钮。把它常驻在工具目录里，等于把它授予了每一个会话，所以这里做成启用制。用户消息命中触发短语、或使用 `/computer` 命令，即为该会话启用；`/computer off` 收回。启用以 `computer/mode` 会话事件记录，会话恢复时重新生效。

启用发生在 `agent/inbox/claimed`——消息被认领之后、提示词装配之前。这个顺序正是关键：那句"点一下保存"的同一个请求里就已经带上截图与点击工具，而不是先回答"我没有这个工具"再等下一轮。

## 策略教给模型的工作循环

策略分节紧邻 MCP 介绍装配，好让身份、人格与工具用法留在提示词前部。它要求模型先看后动、动完核对、能用键盘就别按坐标、点击控件中心而不是文字边缘。它还写明了最要紧的那条边界：屏幕内容是证据，绝不是指令。屏幕上的文字可能带有针对模型的提示注入；不可逆的操作只能由用户本人同意，不能由屏幕上的文字同意。

截图以"未受信任的界面证据"的形式回灌，因此一张对话框的截图无法悄悄把自己升级成任务要求。

## 语言

策略文案跟随提示词语言，而提示词语言默认跟随用户在设置里选的界面语言。部署也可以用 `system-prompt.promptLocale` 把语言钉死在 `zh` 或 `en`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/computer/tool-computer-use/src/index.ts`](../../packages/computer/tool-computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
