/**
 * 电脑操作：按需把桌面控制能力交给模型。
 *
 * ## 为什么是"按需"
 *
 * 桌面控制是这个 harness 里权限最大的一项能力：它能驱动用户真实的鼠标与键盘，
 * 因此它能做的事情远超一个工具调用通常的边界。把它常驻在**动作**层面里，
 * 等于每个会话都默认授予了它。所以这里刻意做成启用制：只有用户用 `/computer`
 * 显式要求、或在消息里明确说出"操作电脑"，动作才会进入模型视野。
 *
 * 常驻的是**入口**，不是动作：通用 `script` 工具的 schema 始终在线上（它属于
 * `@deepseek-ai/dsh-tools`，见 `packages/core/tools/src/script.ts`），而它内部能解析出
 * 哪些动作由启用状态决定。这样开关一次能力不再改动请求最前面的 `tools` 数组，缓存前缀
 * 不必重新计费。
 *
 * ## 四行插件各自的归属
 *
 * - `@deepseek-ai/dsh-computer-use` 是能力登记槽位，`@deepseek-ai/dsh-computer-python`
 *   是 provider，两者都是宿主层的。
 * - 本文件这行也是**宿主层**的，它只做"能力本身"：启用状态、`/computer` 命令、九个动作、
 *   介绍，外加把**自己的动作集**登记给通用 `script` 工具（`ctx.tools.contributeScript`，
 *   见 {@link ./script.ts}）。
 * - 模型侧入口 `script` 由**预设行** `@deepseek-ai/dsh-tools/script` 常驻，理由见下。
 *
 * ## 为什么入口必须是预设行
 *
 * 宿主层的注册落在进程的**全局作用域**上，而全局作用域不属于任何预设、也绕过预设的限制：
 * 注册进那里的工具会进入每一个会话，不管它用的是哪个预设。一条全局注册就能把 `minimal`
 * 变成两个工具——本仓因此有一条 e2e 断言「全局层必须为空」。
 *
 * 「面向模型的工具归属某个预设」是本仓的规矩：`read`/`edit`/`web_fetch` 都是预设自己一行行
 * 声明的。`script` 是面向模型的工具，所以也由预设声明——`standard`/`lean`/`ptc`/`cordis`
 * 各自加那一行，`minimal` 没有加，也就不受影响。
 *
 * ## 为什么动作集是"登记"而不是写进通用工具
 *
 * 通用工具不该知道"电脑"这个字眼：它拥有语法（一行一个动作）、整段先解析、逐行派发；
 * 能力拥有动作。本包登记一张动词表之后，通用行会一并施加扣留与守卫（那九个名字写在
 * 贡献的 `withheld` 里），所以"只有脚本能到达这九个动作"是通用行按贡献统一做到的，
 * 本包不重复实现。以后再加一项能力，也只要写一张动词表，而不是再写一个工具。
 *
 * ## 启用发生在什么时候
 *
 * 提示词与工具 schema 都在**步进开始前**装配，而 `agent/pre-step` 在装配之后才运行，
 * 因此判定挂在 `agent/inbox/claimed` 上——它在消息被认领、装配之前同步触发，
 * 是唯一能让"本步就被启用"的钩子。这条链路让用户在消息里写上"帮我操作电脑点一下保存"，
 * 同一个请求里模型就已经拿到截图与点击工具，不需要额外的往返。
 *
 * ## 三层结构
 *
 * 与 Codex 的做法对齐：静态策略资产（`prompt.ts`）→ 部署可整体替换（`policy` 配置）
 * → 运行时按会话**装载或卸载**（本文件在启用时注册的形态）→ 执行结果以
 * "未受信任的界面证据"回灌（`tools.ts`）。
 *
 * ## 工具与介绍落在哪
 *
 * 模型侧只有**一个**入口：`script`，一段逐行动作脚本的载体。它常驻在**预设**作用域里——
 * 也就是该预设的每条会话从第一步到最后一步都是同一条 schema。本包交出去的是九个动词、
 * 九个受派发的动作名，以及"这九个名字扣留"这一条。
 *
 * 为什么九份 schema 换成一份：
 * - **开关能力不再动缓存前缀。** 九个动作各自一份 schema 时，启用那一刻 `tools` 数组
 *   从 35 条变成 44 条；`tools` 排在请求最前面，整段前缀就此作废（`request/header`
 *   记 `reason=change`）。现在 `tools` 全程不变，变的只有尾部那条介绍。
 * - **扣留 schema 不是目的，是这条路的副作用。** 曾经用 `tools.defer` 配 `tool_search`
 *   隐藏过四个工具：派发读的是注册表、不是请求体，所以它们没变得"不可达"，却变得
 *   **不可调**——模型只为请求自己声明过的函数发 `tool_call`，扣留只会让它改调一个
 *   声明过的邻居、或把名字当纯文本写出来。那一次的错在于扣留之后没有入口。现在九个动作
 *   仍然被扣留，但**没有任何模型侧入口指向它们**：唯一能到达它们的是脚本的嵌套派发，
 *   而嵌套派发不走模型声明。扣留在这里因此是纯粹的减法——通用行再加一道守卫
 *   （`parent` 未置位即拒绝），"只有脚本能到达"就不再只是注释里的说法。
 * - **介绍走尾部。** `systemPrompt.context()` 把策略（含脚本语法与动作清单）落成一条
 *   运行时上下文快照，只在自己变化时替换自己，稳定前缀一个字节都不动。
 *
 * **压缩**是唯一"缓存本来就要重建"的时刻——整段历史刚被摘要替换。那一天到来时介绍才从尾部
 * 快照提升成 `computer:policy` **分段**，此后固定在头部，不必再每步带一条快照。别的时候
 * 一律不动：用户只是开关一次能力，不该单独付一次整段历史重新计费的账。
 *
 * ## 介绍按呈现形态与语言选一份
 *
 * 同一份"怎么用"的指导，在 native 与 PTC 下说的不是同一条路：native 让模型直呼
 * `script`（它在工具清单里），PTC 下那个名字根本不在线上，模型只能从 `run_code` 程序
 * 内部到达它（`await tools.script({ code })`）。说错哪一份，模型都会去调一个那一轮
 * 请求里不存在的函数名。
 *
 * 两个维度都不属于本包：**形态属于预设**（它那一行 `tool-presentation` 声明），
 * **语言属于这次装配**。所以正文在渲染时按两者现选——见 {@link ComputerUseController} 的
 * `policyFor` 与 `prompt.ts` 的 `computerPolicyText`。这也意味着中央译表里不能留
 * `computer:policy` 条目：那张表按分段名无条件替换、不认识形态，会正好把 PTC 措辞换回
 * native 措辞。
 *
 * 一个已知折衷：`computer:policy` 只有在常驻形态下才是**分段**，所以反思文档里写在
 * `## computer:policy` 下面的经验，在提升之前没有落点、不会被注入。
 *
 * 另一个已知折衷：入口是通用的，所以带 `@deepseek-ai/dsh-tools/script` 那一行的预设里，
 * 没启用电脑操作的会话也会看见 `script`。这没有关系——它没有带上任何电脑特有的字眼，
 * 未启用时调用它只会得到"`screenshot` 当前不可用"这样的逐行提示，而该提示要模型告诉用户
 * 该能力尚未启用。宁可宣告一个按需打开的入口，也不让开关能力去动缓存前缀。没带那一行的
 * 预设（`minimal`）不受影响，它的 `/computer` 仍然是老形状：启用时直接把九个动作挂给模型。
 *
 * @module @deepseek-ai/dsh-tool-computer-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: pulls the `compaction/end` session-event declaration this file gates on.
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ComputerUse } from '@deepseek-ai/dsh-computer'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { SCRIPT_TOOL_NAME } from '@deepseek-ai/dsh-tools/script'
import { collectUserText, matchesTrigger } from './activation.ts'
import { COMPUTER_COMMAND_ALIASES, COMPUTER_COMMAND_NAME, DEFAULT_TRIGGER_PHRASES, computerPolicyText } from './prompt.ts'
import { COMPUTER_SCRIPT_CONTRIBUTION } from './script.ts'
import { computerProjectionDefinition, type ComputerUnitState } from './state.ts'
import { registerComputerTools } from './tools.ts'

export type { ComputerUnitState } from './state.ts'
export { COMPUTER_TOOL_NAMES } from './tools.ts'
export { COMPUTER_POLICY, COMPUTER_POLICY_EN, computerPolicyText, DEFAULT_TRIGGER_PHRASES, COMPUTER_COMMAND_NAME, COMPUTER_COMMAND_ALIASES } from './prompt.ts'
export { collectUserText, matchesTrigger, hasCommandToken } from './activation.ts'
export { computerProjectionDefinition } from './state.ts'
export { COMPUTER_SCRIPT_CONTRIBUTION, COMPUTER_SCRIPT_VERBS } from './script.ts'

/**
 * 策略分段名，也是反思文档里的主题键。
 *
 * 与 `mcp:<serverName>` 同为"能力身份即主题键"：用户写在 `## computer:policy`
 * 下面的经验，只会追加到这个分段上；分段不存在（未启用）时它无处可去，
 * 于是自然不被注入。
 */
export const COMPUTER_POLICY_SECTION = 'computer:policy'

/** Plugin configuration. */
export interface Config {
  /**
   * Replaces the built-in policy text wholesale. This is the second layer: a
   * deployment customizes the wording, narrows the safety boundary, or switches
   * languages without changing code.
   */
  policy?: string
  /**
   * Additional trigger phrases beyond the built-in ones, for a team's own
   * vocabulary — an internal product or process name, say.
   */
  extraTriggers?: string[]
}

/** 配置 Schema。 */
export const Config: z<Config> = z.object({
  policy: z.string().default(''),
  extraTriggers: z.array(z.string()).default([]),
})

/** 已解析配置。 */
export interface ResolvedConfig {
  policy: string
  triggers: readonly string[]
}

/**
 * 解析并校验配置。
 *
 * @param config - 原始插件配置。
 * @returns 策略文本（空串表示用内置）与完整触发短语表。
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const unknown = Object.keys(config).filter(key => key !== 'policy' && key !== 'extraTriggers')
  if (unknown.length > 0) {
    throw new Error(`tool-computer-use 配置存在未知字段 ${unknown.join(', ')} —— 只接受 { policy, extraTriggers }`)
  }
  const policy = config.policy ?? ''
  if (typeof policy !== 'string') throw new Error('tool-computer-use 的 policy 必须是字符串')
  const extra = config.extraTriggers ?? []
  if (!Array.isArray(extra) || extra.some(item => typeof item !== 'string')) {
    throw new Error('tool-computer-use 的 extraTriggers 必须是字符串数组')
  }
  const cleaned = extra.map(item => item.trim()).filter(item => item !== '')
  return {
    policy: policy.trim(),
    triggers: [...DEFAULT_TRIGGER_PHRASES, ...cleaned],
  }
}

/** 一次启用所记录的原因，仅用于日志叙述。 */
type ActivationReason = 'command' | 'trigger'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computerController: ComputerUseController
  }
}

/**
 * 装载形态：只决定**介绍**落在哪。工具在两种形态下都照常注册。
 *
 * - `snapshot`：启用当时的临时形态。介绍落成一条**尾部**运行时上下文快照，只在自己变化
 *   时替换自己，稳定前缀一个字节都不动。
 * - `section`：压缩之后提升成的永久形态。介绍是这个会话真正的一节系统提示词
 *   （`computer:policy`），此后不必再每步带一条快照，也不会再有形态切换。
 */
type InstallationMode = 'snapshot' | 'section'

/** 每个会话当前装载的形态。 */
interface Installation {
  readonly agent: Agent
  readonly mode: InstallationMode
  readonly dispose: () => void
}

/**
 * `ctx.computerController`: owns the per-session enablement state, the
 * model-facing `/computer` command, and the `computer:policy` material plus tool
 * set loaded into the agent scope while it is enabled.
 *
 * The material is loaded in one of two modes (see {@link InstallationMode}): the
 * temporary `snapshot` form a fresh `/computer` gets, where the intro is a trailing
 * runtime-context snapshot, and the permanent `section` form applied at the next
 * compaction boundary if computer use is still on, where it becomes a real prompt
 * section.
 *
 * Why the name is not `computerUse`: upstream 0.1.6 defines `ctx.computerUse`
 * as a "only one provider may register at a time" slot
 * (`packages/computer-use`), which is a different concern from this controller.
 * Coexisting under one name would make cordis's provide collide and would leave
 * the type augmentations unmergeable, so this controller yields the name.
 */
export class ComputerUseController extends Service {
  static inject = ['tools', 'systemPrompt', 'sessionProjections']

  private readonly resolved: ResolvedConfig

  /**
   * 本进程内刚启用的会话。投影折叠与日志写入是同步的，但 section 求值可能
   * 早于投影重建，这个集合保证"刚启用"立刻可见。
   */
  private readonly justActivated = new WeakSet<Session>()

  /** 已装载工具集；键是会话，值是注册当时绑定的 agent 与注销器。 */
  private readonly installations = new WeakMap<Session, Installation>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'computerController')
    this.resolved = resolveConfig(config)

    ctx.sessionProjections.register(computerProjectionDefinition)

    // 把九个动词与"扣留这九个名字"交给通用 `script` 工具。登记必须发生在**预设行挂载
    // 之前**，因为那一行在挂载时读一次合并后的动作集来决定注册什么、扣留哪些名字；本行
    // 是宿主行、进程启动时装载，而预设的 standing mount 发生在会话建立时，顺序天然满足。
    // 登记的是数据（动词表），不是注册表里的工具，所以它落在哪个作用域都不构成越权。
    ctx.tools.contributeScript(COMPUTER_SCRIPT_CONTRIBUTION)

    // 最早的可判定点：消息刚被认领、提示词尚未装配。
    // 这里必须同步完成注册，才能让本步就带上工具与策略。
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      this.considerMessage(agent, message)
    })

    // 会话恢复/分叉：日志里已经启用过的会话要重新装载工具。
    //
    // 一律回到临时形态。进程是新起的，这一轮的首个请求本来就要重建缓存，回到常驻
    // 形态并不会省下什么；真有意义的是"此后仍在使用电脑"——那个会话的下一次压缩
    // 会再把它提升一次，而那时的提升依旧是免费的。
    ctx.on('agent/created', ({ agent }) => {
      if (this.isActive(agent.session)) this.install(agent)
    })

    // 压缩边界：唯一"缓存本来就要重建"的时刻（整段历史刚被摘要替换）。临时形态
    // 就在这一刻落地成永久形态，别的时候一律不动。
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/end' || event.data.error !== undefined) return
      const installation = this.installations.get(session)
      if (installation === undefined || installation.mode === 'section') return
      if (!this.isActive(session)) return
      this.install(installation.agent, 'section')
    })

    // 命令是显式入口，也是唯一能"关闭"的入口。
    ctx.inject(['commands'], (commandCtx) => {
      for (const name of [COMPUTER_COMMAND_NAME, ...COMPUTER_COMMAND_ALIASES]) {
        commandCtx.commands.register({
          name,
          description: '启用或关闭电脑操作（屏幕、鼠标、键盘）',
          input: { hint: '[off|message]' },
          handler: async ({ agent, rawInput }) => {
            const message = rawInput.trim()
            if (message === 'off') {
              return this.deactivate(agent)
            }
            const outcome = await this.activate(agent, 'command')
            if (outcome.kind === 'error') return outcome
            if (message !== '') {
              // 命令本身不进入模型历史，因此把随命令带来的话作为用户消息投递，
              // 让模型立刻在已启用的能力下开始工作。
              agent.steer(createUserMessage({
                content: [{ type: 'text', text: message }],
                source: { kind: 'user' },
              }))
            }
            return outcome
          },
        })
      }
    })
  }

  /**
   * 生效的策略文本：部署覆盖优先，其次内置资产（按呈现形态与语言选一份）。
   *
   * 内置资产要选，是因为两份措辞说的**不是同一台机器**：native 措辞让模型直呼
   * `script`，PTC 措辞告诉它必须先写一段 `run_code` 程序。说错哪一份，模型就会去调一个
   * 那一轮请求里根本不存在的函数名。两个维度都不是本包能提前定下的——
   * - **形态属于预设**：同一个 `standard`/`ptc`/`ptc-opt` 组合里各挂一行本包，
   *   形态由预设那一行的 `tool-presentation` 声明，读的是渲染作用域沿链解析的结果。
   * - **语言属于这次装配**：界面语言什么时候切与本包无关。
   * 所以两者都在**渲染时**从装配上下文里读（`text` 是 thunk 的原因）。
   *
   * 覆盖文本原样使用、不参与派生：`policy` 是部署自己写的措辞，替换的就是这两种措辞，
   * 本包猜不出它的哪一句在说入口。
   *
   * @param context - 本次装配的上下文，提供作用域（定形态）与语言（定文本）。
   * @returns 该部署、该会话在这个作用域下应当读到的策略正文。
   */
  private policyFor(context: AssembleContext): string {
    if (this.resolved.policy !== '') return this.resolved.policy
    return computerPolicyText(this.ctx.tools.presentation(context.scope), context.locale ?? 'zh')
  }

  /**
   * Read a session's enablement state, preferring an enable that just happened
   * inside this process.
   *
   * @param session - the target session.
   * @returns whether the capability is enabled.
   */
  isActive(session: Session): boolean {
    if (this.justActivated.has(session)) return true
    return this.projection(session)?.active ?? false
  }

  /** 读取投影状态；缺少投影单元时保持静默（未启用）。 */
  private projection(session: Session): ComputerUnitState | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'computer')
  }

  /**
   * 检查一条刚被认领的消息是否要求启用电脑操作。
   *
   * 只认人类输入：插件通知与工具结果里的文本不得触发启用，
   * 否则一次截图里出现"操作电脑"就足以把能力打开。
   *
   * @param agent - 消息所属 agent。
   * @param message - 被认领的消息。
   */
  private considerMessage(agent: Agent, message: UserMessage): void {
    if (message.source.kind !== 'user') return
    if (this.isActive(agent.session)) return
    const text = collectUserText([message])
    if (!matchesTrigger(text, this.resolved.triggers)) return
    this.activateNow(agent, 'trigger')
  }

  /**
   * 同步启用：写日志、装载工具。用于消息判定路径，
   * 因为它必须在装配之前完成。
   */
  private activateNow(agent: Agent, reason: ActivationReason): void {
    this.justActivated.add(agent.session)
    this.install(agent)
    try {
      agent.session.append('computer/mode', { active: true })
    } catch (error: unknown) {
      this.ctx.logger.warn('tool-computer-use: 记录启用事件失败：%o', error)
    }
    this.ctx.logger.info(
      'tool-computer-use: 会话 %s 已启用电脑操作（%s）',
      agent.session.id,
      reason === 'command' ? '斜杠命令' : '消息命中触发短语',
    )
  }

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
  async activate(agent: Agent, reason: ActivationReason): Promise<{ kind: 'success' | 'error'; text: string }> {
    if (this.isActive(agent.session)) {
      return { kind: 'success', text: '电脑操作已处于启用状态。用 /computer off 关闭。' }
    }
    const status = await this.availability()
    if (!status.available) {
      return {
        kind: 'error',
        text: `无法启用电脑操作：${status.reason ?? '当前宿主不支持桌面控制'}`
          + '（Windows 上还需要安装 Python 3；可用计算机设置里的 computer-python.pythonPath 指定解释器。）',
      }
    }
    this.activateNow(agent, reason)
    return {
      kind: 'success',
      text: `电脑操作已启用（提供方 ${status.provider}）。`
        + `模型现在可以用 ${SCRIPT_TOOL_NAME} 执行脚本：截取屏幕、移动与点击鼠标、输入文本。`
        + '用 /computer off 关闭。',
    }
  }

  /**
   * Turn computer use off: unregister the tools and write the log event.
   *
   * @param agent - the target agent.
   * @returns the command receipt.
   */
  deactivate(agent: Agent): { kind: 'success' | 'error'; text: string } {
    if (!this.isActive(agent.session)) {
      return { kind: 'success', text: '电脑操作本来就未启用。' }
    }
    this.justActivated.delete(agent.session)
    this.uninstall(agent.session)
    try {
      agent.session.append('computer/mode', { active: false })
    } catch (error: unknown) {
      this.ctx.logger.warn('tool-computer-use: 记录关闭事件失败：%o', error)
    }
    this.ctx.logger.info('tool-computer-use: 会话 %s 已关闭电脑操作', agent.session.id)
    return { kind: 'success', text: '电脑操作已关闭：脚本里的动作不再可用，介绍也已移除。' }
  }

  /** 探测宿主能力；没有挂载 provider 时报告为不可用而不是抛错。 */
  private async availability(): Promise<{ available: boolean; provider: string; reason?: string }> {
    const computer: ComputerUse | undefined = this.ctx.get('computer')
    if (computer === undefined) {
      return {
        available: false,
        provider: 'none',
        reason: '没有挂载电脑操作提供方（computer-python）。',
      }
    }
    const status = await computer.available()
    return status.available
      ? { available: true, provider: status.provider }
      : {
        available: false,
        provider: status.provider,
        ...status.reason === undefined ? {} : { reason: status.reason },
      }
  }

  /**
   * 把介绍与动作按 `mode` 装载到该 agent 的作用域；重复装载同一形态是空操作。
   *
   * 九个动作在两种形态下都注册，差的只是介绍落在尾部快照还是头部段落——见 {@link present}。
   * 扣留这九个 schema 的是**预设行** `@deepseek-ai/dsh-tools/script`（按本包登记的动作集），
   * 不是这里：注册表沿作用域链合并扣留表，
   * 所以预设层的扣留盖得住这里注册的动作。没带那一行的预设因此保持老形状——动作照常
   * 出现在请求体里。
   * 注册发生在 `agent.ctx`，因此它们只对这个会话（及其子 agent，作用域链本来就这么
   * 继承）可见。
   *
   * @param agent - 目标 agent。
   * @param mode - 装载形态；默认是启用当时的临时形态 `snapshot`。
   */
  private install(agent: Agent, mode: InstallationMode = 'snapshot'): void {
    const existing = this.installations.get(agent.session)
    if (existing !== undefined && existing.agent === agent && existing.mode === mode) return
    if (existing !== undefined) this.uninstall(agent.session)
    const disposers: Array<() => void> = [
      registerComputerTools(agent.ctx, this.ctx),
      ...this.present(agent, mode),
    ]
    this.installations.set(agent.session, {
      agent,
      mode,
      // 后注册的先注销：策略与工具各自持有独立的注销器，一起退场。
      dispose: () => {
        for (const dispose of disposers.reverse()) dispose()
      },
    })
  }

  /**
   * 介绍的落点，按形态二选一。
   *
   * 永久形态是 `computer:policy` 分段：介绍真成了这个会话系统提示词的一节。
   *
   * 临时形态把它落成运行时上下文：变的只是它落在消息尾部而不是请求头部，
   * 于是开关能力不动稳定前缀。
   *
   * 两种形态都注册成**函数**，因为正文要到渲染时才知道：呈现形态属于预设
   * （见 {@link policyFor}），语言属于这次装配。这里也不再借助装配期的本地化包装
   * 间接换语言——`computer:policy` 在中央译表里已经**没有**条目了，那张表按分段名
   * 无条件替换、不认识形态，会把 PTC 措辞换回 native 措辞。本包自己按
   * `context.locale` 给英文，是那张表模块头写明的终态。
   *
   * 介绍因此是**动作清单唯一的落点**：动作的 schema 不在请求体里（被预设行
   * `@deepseek-ai/dsh-tools/script` 扣留），模型要知道脚本能写哪些动作，读的就是这一节。
   *
   * @param agent - 目标 agent。
   * @param mode - 装载形态。
   * @returns 该形态下需要一并注销的注册项。
   */
  private present(agent: Agent, mode: InstallationMode): Array<() => void> {
    if (mode === 'section') {
      return [agent.ctx.systemPrompt.section({
        name: COMPUTER_POLICY_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('COMPUTER_USE_POLICY'),
        text: context => this.policyFor(context),
      })]
    }
    // 与 MCP 服务器同构的一步：能力在，介绍才在。"未启用不显示"因此不靠过滤实现，
    // 而是靠根本没注册——编辑面也就不会留下一行空的电脑操作。
    return [agent.ctx.systemPrompt.context({
      name: COMPUTER_POLICY_SECTION,
      order: agent.ctx.systemPrompt.getContextOrder('COMPUTER_USE_POLICY'),
      text: context => this.policyFor(context),
    })]
  }

  /** 注销该会话已装载的工具集与介绍，无论它当前处于哪种形态。 */
  private uninstall(session: Session): void {
    const existing = this.installations.get(session)
    if (existing === undefined) return
    this.installations.delete(session)
    try {
      existing.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn('tool-computer-use: 注销工具失败：%o', error)
    }
  }
}

export default ComputerUseController
