/**
 * 电脑操作能力的 Service Definition（`ctx.computer`）：把"看屏幕、点鼠标、
 * 敲键盘"抽象成一个可替换的 seam。
 *
 * 为什么是 seam 而不是一个直接调外部程序的工具包：桌面操作天然与执行世界
 * 绑定（宿主桌面、远程桌面、容器内虚拟显示各不相同），Provider 换一个实现，
 * 上层工具与提示词无需改动。本包不含任何实现，也不做平台探测。
 *
 * @module @deepseek-ai/dsh-computer
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ComputerAvailability,
  ComputerCallOptions,
  ComputerClickInput,
  ComputerDisplay,
  ComputerDragInput,
  ComputerDragResult,
  ComputerKeyInput,
  ComputerPoint,
  ComputerScreenshot,
  ComputerScrollInput,
  ComputerTypeInput,
} from './types.ts'

export {
  ComputerError,
} from './types.ts'
export type {
  ComputerAvailability,
  ComputerCallOptions,
  ComputerClickInput,
  ComputerDisplay,
  ComputerDragInput,
  ComputerDragResult,
  ComputerErrorCode,
  ComputerKeyInput,
  ComputerMouseButton,
  ComputerPoint,
  ComputerScreenshot,
  ComputerScrollInput,
  ComputerTypeInput,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computer: ComputerUse
  }
}

/**
 * 电脑操作能力。实现类负责平台细节、外部进程生命周期与错误归类；
 * 调用方只依赖这组语义。
 *
 * 契约：
 * - 所有坐标处于同一坐标系：{@link ComputerDisplay} 描述的虚拟屏幕物理像素。
 *   截图与输入必须共用它，否则点击会落在错误的位置。
 * - 每个方法都接受取消信号；中止时必须终止自己启动的进程并尽快 settle。
 * - 预期失败抛出带稳定 code 的 `ComputerError`，不抛出平台原始错误。
 */
export abstract class ComputerUse extends Service {
  constructor(ctx: Context) {
    super(ctx, 'computer')
  }

  /** 提供方标识，用于诊断与提示词叙述。 */
  abstract readonly provider: string

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
}

export default ComputerUse
