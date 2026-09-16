/**
 * 电脑操作能力的类型词汇：屏幕几何、指针位置、输入动作与错误码。
 *
 * 这些类型同时是 Service Definition、Service Provider 与 Consumer 之间的契约，
 * 只描述"要做什么"，不描述"在哪台机器上用什么技术做"。
 *
 * @module @deepseek-ai/dsh-computer/types
 */

/** 屏幕几何信息，坐标一律是宿主桌面的物理像素。 */
export interface ComputerDisplay {
  /** 虚拟屏幕左上角在桌面坐标系中的 x。多显示器时可能为负。 */
  readonly originX: number
  /** 虚拟屏幕左上角在桌面坐标系中的 y。 */
  readonly originY: number
  /** 整个虚拟屏幕的像素宽度。 */
  readonly width: number
  /** 整个虚拟屏幕的像素高度。 */
  readonly height: number
  /** 主显示器宽度。 */
  readonly primaryWidth: number
  /** 主显示器高度。 */
  readonly primaryHeight: number
}

/** 桌面坐标系中的一个点。 */
export interface ComputerPoint {
  readonly x: number
  readonly y: number
}

/**
 * 一次屏幕截图。像素与 {@link ComputerDisplay} 处在同一坐标系；
 * 这里重复声明几何字段而不是继承，因为截图只覆盖虚拟屏幕那一部分信息，
 * 也不携带主显示器尺寸。
 */
export interface ComputerScreenshot {
  /** 截图左上角对应的屏幕坐标 x。 */
  readonly originX: number
  /** 截图左上角对应的屏幕坐标 y。 */
  readonly originY: number
  /** 截图像素宽度。 */
  readonly width: number
  /** 截图像素高度。 */
  readonly height: number
  /** 编码后的 PNG 字节。 */
  readonly data: Uint8Array
}

/** 可用的鼠标按键。 */
export type ComputerMouseButton = 'left' | 'right' | 'middle'

/** `click` 动作的输入。 */
export interface ComputerClickInput extends Partial<ComputerPoint> {
  /** 默认 `left`。 */
  readonly button?: ComputerMouseButton
  /** 连击次数，1..3，默认 1。 */
  readonly clicks?: number
}

/** `drag` 动作的输入；起点终点都必填。 */
export interface ComputerDragInput {
  readonly fromX: number
  readonly fromY: number
  readonly toX: number
  readonly toY: number
  /** 默认 `left`。 */
  readonly button?: ComputerMouseButton
  /** 拖拽总时长，默认 350ms。 */
  readonly durationMs?: number
}

/** `drag` 动作的结果：终点同时也是执行完之后的指针位置。 */
export interface ComputerDragResult {
  readonly fromX: number
  readonly fromY: number
  readonly toX: number
  readonly toY: number
  readonly button: string
}

/** `scroll` 动作的输入；delta 使用 Windows 滚轮单位（120 表示一格）。 */
export interface ComputerScrollInput extends Partial<ComputerPoint> {
  readonly deltaX?: number
  readonly deltaY?: number
}

/** `type` 动作的输入。 */
export interface ComputerTypeInput extends Partial<ComputerPoint> {
  /** 要输入的文本，支持换行与制表符。 */
  readonly text: string
}

/** `key` 动作的输入。 */
export interface ComputerKeyInput extends Partial<ComputerPoint> {
  /** 组合键序列，例如 `['ctrl', 'c']`；按顺序按下、逆序抬起。 */
  readonly keys: readonly string[]
}

/** 稳定错误码，供 Consumer 归类失败而不是解析文本。 */
export type ComputerErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'CAPTURE_FAILED'
  | 'INPUT_FAILED'
  | 'RUNTIME_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'

/** 电脑操作失败。Provider 抛出的每个预期失败都带稳定 code。 */
export class ComputerError extends Error {
  constructor(message: string, readonly code: ComputerErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ComputerError'
  }
}

/**
 * 电脑操作能力的可用性快照。Consumer 用它决定注册哪些工具，以及把哪段
 * 不可用说明写给用户。
 */
export interface ComputerAvailability {
  /** 可以执行动作时为 true。 */
  readonly available: boolean
  /** 提供方标识，例如 `python-win32`。 */
  readonly provider: string
  /** 宿主平台标识，例如 `win32`。 */
  readonly platform: string
  /** 不可用时的原因，可直接展示给用户。 */
  readonly reason?: string
}

/** 各动作共用的调用选项。 */
export interface ComputerCallOptions {
  /** 取消信号；Provider 必须转发到子进程并在中止时终止它。 */
  readonly signal?: AbortSignal
}
