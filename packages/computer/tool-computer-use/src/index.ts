/**
 * 电脑操作：按需把桌面控制能力交给模型。
 *
 * ## 为什么是"按需"
 *
 * 桌面控制是这个 harness 里权限最大的一项能力：它能驱动用户真实的鼠标与键盘，
 * 因此它能做的事情远超一个工具调用通常的边界。把它常驻在工具目录里，
 * 等于每个会话都默认授予了它。所以这里刻意做成启用制：只有用户用 `/computer`
 * 显式要求、或在消息里明确说出"操作电脑"，能力才会进入模型视野。
 *
 * ## 启用发生在什么时候
 *
 * 提示词与工具 schema 都在**步进开始前**装配，而 `agent/pre-step` 在装配之后才运行，
 * 因此判定挂在 `agent/inbox/claimed` 上——它在消息被认领、装配之前同步触发，
 * 是唯一能让"本步就被启用"的钩子。这条链路让用户在消息里写上"帮我操作电脑点一下保存"，
 * 同一个请求里模型就已经拿到截图与点击工具，不需要额外的往返。
 *
 * ## 四层结构
 *
 * 与 Codex 的做法对齐：静态策略资产（`prompt.ts`）→ 部署可整体替换（`policy` 配置）
 * → 运行时按会话**装载或卸载**（本文件在启用时注册的形态）→ 执行结果以
 * "未受信任的界面证据"回灌（`tools.ts`）。
 *
 * ## 启用后的两种形态，以及为什么非要两种
 *
 * 提示词与工具 schema 都排在请求最前面，动它们等于作废整个长会话的缓存前缀。而电脑
 * 操作恰恰是**会话中途**才被要求启用的能力——一次 `/computer` 就让几万 token 的历史
 * 重新计费，代价与收益完全不成比例。所以启用先取**临时形态**：
 * - 工具走 `tools:on-demand`（组合里本来就有取用通道时）：照常注册，但 schema 不上
 *   wire，模型要用先经 `tool_search` 取；
 * - 介绍走 `systemPrompt.context()` 而不是 `systemPrompt.section()`：它落成一条**尾部**
 *   的运行时上下文快照，只在自己变化时替换自己，稳定前缀一个字节都不动。
 *
 * **压缩**是唯一"缓存本来就要重建"的时刻——整段历史刚被摘要替换。那一天到来时才把
 * 临时形态提升成永久形态：工具转常驻、介绍转 `computer:policy` 分段。别的时候一律
 * 不动：用户只是开关一次能力，不该付出整段历史重新计费的代价。
 *
 * 两种形态都不越过"未启用就什么都不注册"这条线：没启用的会话既没有工具也没有介绍，
 * 编辑面上自然查无此节（与 Claude Code 把电脑操作挂成 MCP 服务器的形状一致——
 * `ListTools` 在禁用时返回空列表，而不是宣告一个空壳）。
 *
 * 一个已知折衷：`computer:policy` 只有在常驻形态下才是**分段**，所以反思文档里写在
 * `## computer:policy` 下面的经验，在提升之前没有落点、不会被注入。
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
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { TOOL_SEARCH_NAME } from '@deepseek-ai/dsh-tools/search'
import { collectUserText, matchesTrigger } from './activation.ts'
import { COMPUTER_POLICY, COMPUTER_COMMAND_ALIASES, COMPUTER_COMMAND_NAME, DEFAULT_TRIGGER_PHRASES } from './prompt.ts'
import { computerProjectionDefinition, type ComputerUnitState } from './state.ts'
import { COMPUTER_TOOL_NAMES, registerComputerTools } from './tools.ts'

export type { ComputerUnitState } from './state.ts'
export { COMPUTER_TOOL_NAMES } from './tools.ts'
export { COMPUTER_POLICY, DEFAULT_TRIGGER_PHRASES, COMPUTER_COMMAND_NAME, COMPUTER_COMMAND_ALIASES } from './prompt.ts'
export { collectUserText, matchesTrigger, hasCommandToken } from './activation.ts'
export { computerProjectionDefinition } from './state.ts'

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
 * 装载形态。
 *
 * - `on-demand`：启用当时的**临时**形态。工具注册但 schema 不上 wire（组合里有取用
 *   通道时），介绍落在尾部的运行时上下文快照里。开关一次能力不动稳定前缀。
 * - `resident`：压缩之后提升成的**永久**形态。工具常驻，介绍是这个会话真正的一节
 *   系统提示词。此后不会再有任何形态切换。
 */
type InstallationMode = 'on-demand' | 'resident'

/** 每个会话当前装载的形态。 */
interface Installation {
  readonly agent: Agent
  readonly mode: InstallationMode
  readonly dispose: () => void
}

/**
 * `ctx.computerController`: owns the on-demand enablement state, the
 * model-facing `/computer` command, and the `computer:policy` material plus tool
 * set loaded into the agent scope while it is enabled.
 *
 * The material is loaded in one of two modes (see {@link InstallationMode}): the
 * temporary `on-demand` form a fresh `/computer` gets, and the permanent
 * `resident` form applied at the next compaction boundary if computer use is
 * still on.
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
      if (installation === undefined || installation.mode === 'resident') return
      if (!this.isActive(session)) return
      this.install(installation.agent, 'resident')
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

  /** 生效的策略文本：部署覆盖优先，其次内置资产。 */
  private get policyText(): string {
    return this.resolved.policy === '' ? COMPUTER_POLICY : this.resolved.policy
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
        + '模型现在可以截取屏幕、移动与点击鼠标、输入文本。用 /computer off 关闭。',
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
    return { kind: 'success', text: '电脑操作已关闭，相关工具已从模型视野移除。' }
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
   * 把介绍与工具按 `mode` 装载到该 agent 的作用域；重复装载同一形态是空操作。
   *
   * 工具在两种形态下都注册，差的只是上不上 wire 与介绍落在哪——见 {@link present}。
   * 注册发生在 `agent.ctx`，因此它们只对这个会话（及其子 agent，作用域链本来就这么
   * 继承）可见。
   *
   * @param agent - 目标 agent。
   * @param mode - 装载形态；默认是启用当时的临时形态 `on-demand`。
   */
  private install(agent: Agent, mode: InstallationMode = 'on-demand'): void {
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
   * 介绍的落点与工具的可见性，按形态二选一。
   *
   * 常驻形态就是老样子：一个 `computer:policy` 分段 + 一组普通工具。
   *
   * 临时形态把两样都挪到"改了也不动稳定前缀"的位置。工具那一半只在组合**本来就有**
   * 取用通道时才跟进——`tool_search` 的取用工具与 on-demand 索引分段是同一行装配出来
   * 的，所以"入口在不在"直接问注册表。没有入口却把 schema 藏起来，等于让模型永远拿
   * 不到它：那种组合里工具保持常驻，能力照常可用，代价只是回到老样子。
   *
   * @param agent - 目标 agent。
   * @param mode - 装载形态。
   * @returns 该形态下需要一并注销的注册项。
   */
  private present(agent: Agent, mode: InstallationMode): Array<() => void> {
    if (mode === 'resident') {
      return [agent.ctx.systemPrompt.section({
        name: COMPUTER_POLICY_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('COMPUTER_USE_POLICY'),
        text: () => this.policyText,
      })]
    }
    const disposers: Array<() => void> = []
    if (agent.ctx.tools.get(TOOL_SEARCH_NAME, scopeOf(agent.ctx)) !== undefined) {
      disposers.push(agent.ctx.tools.defer(COMPUTER_TOOL_NAMES))
    }
    // 与 MCP 服务器同构的一步：能力在，介绍才在。"未启用不显示"因此不靠过滤实现，
    // 而是靠根本没注册——编辑面也就不会留下一行空的电脑操作。
    //
    // 这一段暂时不是分段而是运行时上下文：文本照旧是函数求值（装配期的本地化包装
    // 走的还是原路径，中文资产 ↔ 英文兜底见 localized-sections），变的只是它落在
    // 消息尾部而不是请求头部。
    disposers.push(agent.ctx.systemPrompt.context({
      name: COMPUTER_POLICY_SECTION,
      order: agent.ctx.systemPrompt.getContextOrder('COMPUTER_USE_POLICY'),
      text: () => this.policyText,
    }))
    return disposers
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
