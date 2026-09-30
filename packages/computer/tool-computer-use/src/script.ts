/**
 * 电脑操作交给 `script` 工具的动作集。
 *
 * ## 这一包为什么不再有自己的入口
 *
 * 之前这里是一个完整的模型侧工具（`computer_script`）：解析器、动词表、启停判据都在本包。
 * 但"脚本"不是电脑操作独有的形状——任何一组"看 → 做 → 核对"的动作都更适合写成逐行脚本，
 * 而不是各自占一份 schema。于是解析器、派发、扣留、守卫都搬进了 `@deepseek-ai/dsh-tools`
 * 的通用 `script` 工具（见 `packages/core/tools/src/script.ts`），本包只留下**自己的能力
 * 是什么**：九个动词指向哪九个动作、哪些动作只能由脚本到达。
 *
 * 形状上这是 `ctx.tools.contributeScript()` 的一次调用，由 {@link ComputerUseController}
 * 在构造时登记。于是：
 *
 * - 通用工具不必知道"电脑"这个字眼，它的描述保持通用、简短；
 * - 以后再加一项能力，只要写一张动词表，不需要再写一个工具；
 * - 扣留与守卫由通用行按**贡献**统一施加（`withheld` 那九条），本包不重复实现一遍。
 *
 * ## 为什么启用状态不在这里
 *
 * 这里只声明"动作存在"。某个动作此刻能不能用，由通用工具在**解析前**查注册表得出：
 * 电脑操作没启用时，九个动作没有注册进该会话的作用域，查不到就整段拒绝，并指出行号。
 * 所以本文件没有开关，也不该有——它是一张静态表。
 *
 * ## 位置参数
 *
 * 位置参数只为常见写法省字（`click 100 200`、`key ctrl,s`）；其余参数一律 `名字=值`。
 * 参数类型不在这里声明第二遍——通用解析器读的是目标动作自己的参数规格，见
 * `readScriptParameters`。
 *
 * @module @deepseek-ai/dsh-tool-computer-use/script
 */

import type { ScriptContribution, ScriptVerb } from '@deepseek-ai/dsh-tools'
import { COMPUTER_TOOL_NAMES } from './tools.ts'

/** 脚本可用的动作；键就是脚本里写的名字。 */
export const COMPUTER_SCRIPT_VERBS: Readonly<Record<string, ScriptVerb>> = {
  screenshot: { tool: 'computer_screenshot', positional: [] },
  display: { tool: 'computer_display', positional: [] },
  pointer: { tool: 'computer_pointer', positional: [] },
  move: { tool: 'computer_move', positional: ['x', 'y'] },
  click: { tool: 'computer_click', positional: ['x', 'y'] },
  drag: { tool: 'computer_drag', positional: ['fromX', 'fromY', 'toX', 'toY'] },
  type: { tool: 'computer_type', positional: ['text', 'x', 'y'] },
  key: { tool: 'computer_key', positional: ['keys', 'x', 'y'] },
  scroll: { tool: 'computer_scroll', positional: ['deltaY', 'deltaX', 'x', 'y'] },
}

/**
 * 本包交给通用 `script` 工具的完整贡献。
 *
 * `withheld` 就是那九个动作名：它们仍然注册在注册表里（脚本的派发目标），但 schema
 * 不进请求体，且模型直呼会被通用行钉下的守卫拒绝——所以"只有脚本能到达"是事实而不是注释。
 * 这一条以前写在预设行的插件里，现在跟着动作集一起放在能力这一侧：哪些动作是脚本形状，
 * 只有能力自己知道。
 */
export const COMPUTER_SCRIPT_CONTRIBUTION: ScriptContribution = {
  id: 'computer-use',
  verbs: COMPUTER_SCRIPT_VERBS,
  withheld: COMPUTER_TOOL_NAMES,
}
