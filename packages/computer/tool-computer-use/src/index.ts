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
 * → 运行时按会话**装载或卸载**（本文件在启用时注册的 section）→ 执行结果以
 * "未受信任的界面证据"回灌（`tools.ts`）。
 *
 * ## 策略分节为什么在启用时才注册
 *
 * `computer:policy` 不是全局注册后靠"文本为空"自我隐藏的——它和工具在**同一时机、
 * 同一作用域**注册（`install`），也在同一时机退场（`uninstall`）。这与 Claude Code
 * 把电脑操作挂成一个 MCP 服务器的形状一致：`ListTools` 在禁用时返回空列表，
 * 能力不存在就什么都不宣告，而不是宣告一个空壳。
 *
 * 两个后果值得点名：
 * - 提示词与工具永远同进同退。策略说"你可以点击鼠标"时，那些工具必然就在工具目录里；
 *   反过来，没启用的会话既没有工具也没有这一段。
 * - 编辑面不再多出一行空的"电脑操作"。未启用的能力**根本没注册**，卡片上自然查无此节；
 *   文档里若还留着它的旧经验，卡片会把它们计入"没有对应能力"的那一类。
 *
 * @module @deepseek-ai/dsh-tool-computer-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { ComputerUse } from '@deepseek-ai/dsh-computer'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { collectUserText, matchesTrigger } from './activation.ts'
import { COMPUTER_POLICY, COMPUTER_COMMAND_ALIASES, COMPUTER_COMMAND_NAME, DEFAULT_TRIGGER_PHRASES } from './prompt.ts'
import { computerProjectionDefinition, type ComputerUnitState } from './state.ts'
import { registerComputerTools } from './tools.ts'

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

/** 插件配置。 */
export interface Config {
  /**
   * 整体替换内置策略文本。这是"第二层"：部署可以用它定制措辞、
   * 收窄安全边界或换成另一种语言，而不用改代码。
   */
  policy?: string
  /**
   * 追加触发短语（在内置短语之外）。用于接入团队自己的说法，
   * 例如某个内部产品或流程的专有名称。
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
    computerUse: ComputerUseController
  }
}

/** 每个会话当前装载的工具集。 */
interface Installation {
  readonly agent: Agent
  readonly dispose: () => void
}

/**
 * `ctx.computerUse`：拥有按需启用状态、面向模型的 `/computer` 命令，
 * 以及启用期间装载到 agent 作用域的 `computer:policy` 策略分节与工具集。
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
    super(ctx, 'computerUse')
    this.resolved = resolveConfig(config)

    ctx.sessionProjections.register(computerProjectionDefinition)

    // 最早的可判定点：消息刚被认领、提示词尚未装配。
    // 这里必须同步完成注册，才能让本步就带上工具与策略。
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      this.considerMessage(agent, message)
    })

    // 会话恢复/分叉：日志里已经启用过的会话要重新装载工具。
    ctx.on('agent/session-start', ({ agent }) => {
      if (this.isActive(agent.session)) this.install(agent)
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
   * 读取会话的启用状态，优先返回本进程内刚发生的启用。
   *
   * @param session - 目标会话。
   * @returns 是否启用。
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
   * 显式启用（命令路径）。命令在步进之外运行，因此可以先探测宿主能力，
   * 把"这台机器不能用"作为可读的失败返回给用户，而不是留到第一次点击才炸。
   *
   * @param agent - 目标 agent。
   * @param reason - 启用原因，用于日志。
   * @returns 命令回执。
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
   * 关闭电脑操作：注销工具并写入日志事件。
   *
   * @param agent - 目标 agent。
   * @returns 命令回执。
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
   * 把策略分节与工具装载到该 agent 的作用域；重复装载同一个 agent 是空操作。
   *
   * 两者必须同时注册：策略是"你能动这台电脑"的宣告，工具是这句话的兑现，
   * 分开就会出现"说得到做不到"或"能做但没告知"的错位。注册发生在 `agent.ctx`，
   * 因此它们只对这个会话（及其子 agent，作用域链本来就这么继承）可见。
   */
  private install(agent: Agent): void {
    const existing = this.installations.get(agent.session)
    if (existing !== undefined && existing.agent === agent) return
    if (existing !== undefined) this.uninstall(agent.session)
    const disposers: Array<() => void> = [
      registerComputerTools(agent.ctx, this.ctx),
      // 与 MCP 服务器同构的一步：能力在，介绍才在。"未启用不显示"因此不靠
      // 过滤实现，而是靠根本没注册——编辑面也就不会留下一行空的电脑操作。
      //
      // 这一次只改"何时注册"，没改"文本从哪来"：仍旧用函数求值，装配期的
      // 本地化包装走的还是原路径（中文资产 ↔ 英文兜底见 localized-sections）。
      agent.ctx.systemPrompt.section({
        name: COMPUTER_POLICY_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('COMPUTER_USE_POLICY'),
        text: () => this.policyText,
      }),
    ]
    this.installations.set(agent.session, {
      agent,
      // 后注册的先注销：策略与工具各自持有独立的注销器，一起退场。
      dispose: () => {
        for (const dispose of disposers.reverse()) dispose()
      },
    })
  }

  /** 注销该会话已装载的工具集与策略分节。 */
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
