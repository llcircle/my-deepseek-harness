/**
 * 电脑操作的会话状态：一份追加式日志事件加一个折叠它的投影。
 *
 * 为什么走日志而不是只放内存：能力一旦启用，就会改变模型可以看到的工具集合。
 * dsh 的不变量是"模型可见即可从日志重建"，所以启用与关闭都必须留下事件，
 * 会话恢复（resume/fork）后能力状态才和当初一致。
 *
 * @module @deepseek-ai/dsh-tool-computer-use/state
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether the computer-use capability is visible to the model from this
     * point on: log-only, not rendered by any UI, and replacing wholesale. The
     * last `computer/mode` wins; with none in the log it folds to disabled.
     */
    'computer/mode': { active: boolean }
  }
}

/** `computer` 投影的状态。 */
export interface ComputerUnitState {
  /** 能力当前是否对该会话启用。 */
  readonly active: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    computer: ComputerUnitState
  }
}

const computerUnitStateSchema: ZodType<ComputerUnitState> = zod.object({
  active: zod.boolean(),
}).strict()

/** 投影单元：折叠 `computer/mode`，其余事件原样返回同一个引用。 */
export const computerProjectionDefinition = {
  key: 'computer',
  stateVersion: 1,
  stateSchema: computerUnitStateSchema,
  init: () => ({ active: false }),
  apply: (state, event) => {
    if (event.type !== 'computer/mode') return state
    if (state.active === event.data.active) return state
    return { active: event.data.active }
  },
} satisfies ProjectionDefinition<'computer', ComputerUnitState>
