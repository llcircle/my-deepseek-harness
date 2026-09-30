/**
 * 电脑操作与通用脚本工具之间的**接缝测试**。
 *
 * 解析器本身的判据已经搬到 `@deepseek-ai/dsh-tools` 的 `script.spec.ts`（那里用的是合成动词，
 * 因为入口不该知道任何能力）。本文件守着另一半——这一侧唯一会漂移的东西：
 *
 * - 动词表里每一个位置参数名，都真的存在于该动作自己的参数声明里（改了参数名却忘了改位置
 *   顺序，会在这里红）；
 * - 动词表覆盖九个动作、不多不少，且指向的就是那九个名字；
 * - 登记给通用行的扣留名单与九个动作一致——漏一个就意味着某个动作的 schema 会上线。
 *
 * 参数规格不手抄一份假的：这里真的把那九个动作注册进一个测试注册表，再让解析器去读
 * 它们的 `parameters`。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ScriptParseContext } from '@deepseek-ai/dsh-tools/script'
import { parseScript, readScriptParameters } from '@deepseek-ai/dsh-tools/script'
import { COMPUTER_SCRIPT_CONTRIBUTION, COMPUTER_SCRIPT_VERBS } from '../src/script.ts'
import { COMPUTER_TOOL_NAMES, registerComputerTools } from '../src/tools.ts'

/** 用真实注册表搭一个查询器：参数规格来自那九个动作自己的声明。 */
async function realContext(): Promise<ScriptParseContext> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  registerComputerTools(ctx, ctx)
  return {
    verbs: COMPUTER_SCRIPT_VERBS,
    parametersOf: (tool) => {
      const declared = ctx.tools.get(tool)?.parameters
      return declared === undefined ? undefined : readScriptParameters(declared)
    },
  }
}

/** 解析成功时取回唯一的那个动作的实参。 */
function argsOf(context: ScriptParseContext, code: string): Readonly<Record<string, unknown>> {
  const steps = parseScript(code, context)
  expect(steps).toHaveLength(1)
  return steps[0]!.args
}

describe('电脑操作的动词表与动作声明不漂移', () => {
  it('覆盖九个动作，且每个位置参数名都真的存在于该动作的声明里', async () => {
    const context = await realContext()
    const verbs = Object.entries(COMPUTER_SCRIPT_VERBS)
    expect(verbs.map(([name]) => name).sort()).toEqual([
      'click', 'display', 'drag', 'key', 'move', 'pointer', 'screenshot', 'scroll', 'type',
    ])
    // 漂移守卫：改了 action 的参数名却忘了改位置参数顺序，会在这里红。
    for (const [verb, spec] of verbs) {
      const parameters = context.parametersOf(spec.tool)
      expect(parameters, `${verb} → ${spec.tool} 没有注册`).toBeDefined()
      for (const name of spec.positional) {
        expect(Object.keys(parameters ?? {}), `${verb} 的位置参数 ${name}`).toContain(name)
      }
    }
  })

  it('每个动词指向的就是那九个动作之一', () => {
    for (const spec of Object.values(COMPUTER_SCRIPT_VERBS)) {
      expect(COMPUTER_TOOL_NAMES).toContain(spec.tool)
    }
  })

  it('登记给通用脚本工具的扣留名单就是那九个动作', () => {
    // 漏一个名字 = 那个动作的 schema 会上线；多一个名字 = 通用行会去扣留一个不存在的工具。
    expect([...COMPUTER_SCRIPT_CONTRIBUTION.withheld ?? []].sort()).toEqual([...COMPUTER_TOOL_NAMES].sort())
  })

  it('位置参数名不重复，且顺序与脚本写法一致', () => {
    for (const [verb, spec] of Object.entries(COMPUTER_SCRIPT_VERBS)) {
      expect(new Set(spec.positional).size, `${verb} 的位置参数有重复`).toBe(spec.positional.length)
    }
    expect(COMPUTER_SCRIPT_VERBS['drag']?.positional).toEqual(['fromX', 'fromY', 'toX', 'toY'])
    expect(COMPUTER_SCRIPT_VERBS['scroll']?.positional).toEqual(['deltaY', 'deltaX', 'x', 'y'])
  })
})

describe('电脑操作的脚本写法', () => {
  it('坐标与按键按声明强制成型', async () => {
    const context = await realContext()
    expect(argsOf(context, 'click 100 200')).toEqual({ x: 100, y: 200 })
    expect(argsOf(context, 'move 640 360')).toEqual({ x: 640, y: 360 })
    expect(argsOf(context, 'drag 1 2 3 4')).toEqual({ fromX: 1, fromY: 2, toX: 3, toY: 4 })
    expect(argsOf(context, 'key ctrl,shift,s')).toEqual({ keys: ['ctrl', 'shift', 's'] })
  })

  it('无参动作与带坐标的输入动作都解析得出来', async () => {
    const context = await realContext()
    expect(argsOf(context, 'screenshot')).toEqual({})
    expect(argsOf(context, 'pointer')).toEqual({})
    expect(argsOf(context, 'type "你好，世界"')).toEqual({ text: '你好，世界' })
    expect(argsOf(context, 'type "你好" x=10 y=20')).toEqual({ text: '你好', x: 10, y: 20 })
  })

  it('滚动默认只看 deltaY，命名参数可以补上横向与坐标', async () => {
    const context = await realContext()
    expect(argsOf(context, 'scroll -120')).toEqual({ deltaY: -120 })
    expect(argsOf(context, 'scroll deltaX=-60 deltaY=120 x=5 y=6'))
      .toEqual({ deltaX: -60, deltaY: 120, x: 5, y: 6 })
  })

  it('点错参数名会指出正确的那几个', async () => {
    const context = await realContext()
    expect(() => parseScript('click 1 2 buton=right', context))
      .toThrowError(/line 1: `click` has no parameter `buton`; available: /)
  })

  it('未启用的动作报"当前不可用"，且只报出问题的那一行', async () => {
    // 能力没启用时注册表里没有那九个动作，这是真实的失败形状。
    const context: ScriptParseContext = { verbs: COMPUTER_SCRIPT_VERBS, parametersOf: () => undefined }
    expect(() => parseScript('screenshot\nclick 1 2', context))
      .toThrowError(/line 1: `screenshot` is not available/)
  })
})
