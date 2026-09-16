/**
 * Plugins settings surface, browser half — one section whose feature-owned
 * tabs include configurable Host plugin cards and read-only inventory.
 *
 * The section declares `settings.plugins.tab`; its own `configurable` tab then
 * declares `settings.plugin.item` and renders whatever cards were registered
 * into it. The cards this package ships are the host-plane sections the
 * deployment already exposes; each binds its namespace through the client
 * settings scope, which keeps them unaware of one another and of other tabs.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry)
// and the ctx.settingsScope Context merge. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AgentLoopCard } from './AgentLoopCard.tsx'
import { BashCard } from './BashCard.tsx'
import { ConfigurablePluginsTab } from './ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from './PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionInjected, PluginsSettingsTabEntry } from './PluginsSettingsSection.tsx'
import { SubagentModelSelectionCard } from './SubagentModelSelectionCard.tsx'
import { WebSearchCard } from './WebSearchCard.tsx'
import { SkillTriggerCard } from './SkillTriggerCard.tsx'
import { LlmRetryCard } from './LlmRetryCard.tsx'
import { PromptOverridesCard } from './PromptOverridesCard.tsx'
import { AGENT_LOOP_NS, AgentLoopCardController } from './agent-loop-card-controller.ts'
import { SHELL_NS, BashCardController } from './bash-card-controller.ts'
import { ConfigurablePluginsTabController } from './tab-store.ts'
import {
  SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController,
} from './subagent-model-selection-card-controller.ts'
import { WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import {
  SKILL_FILESYSTEM_NS, SkillTriggerCardController,
} from './skill-trigger-card-controller.ts'
import { LLM_DEEPSEEK_NS, LlmRetryCardController } from './llm-retry-card-controller.ts'
import {
  SYSTEM_PROMPT_OVERRIDES_NS, PromptOverridesCardController,
} from './prompt-overrides-card-controller.ts'
import { en, zh } from './locales.ts'

export type { PluginsSettingsSectionInjected, PluginsSettingsSectionProps } from './PluginsSettingsSection.tsx'
export type { ConfigurablePluginsTabProps } from './ConfigurablePluginsTab.tsx'
export type { ConfigurablePluginsTabFace, ConfigurablePluginsTabState } from './tab-store.ts'
export type { PluginCardProps } from './PluginCard.tsx'
export type { SettingsPluginItemOwnerProps } from './slot-contract.ts'
export type { FieldProps } from './fields.tsx'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export type { AgentLoopCardFace, AgentLoopCardState } from './agent-loop-card-controller.ts'
export type { BashCardFace, BashCardState } from './bash-card-controller.ts'
export type { WebSearchCardFace, WebSearchCardState } from './web-search-card-controller.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.plugins'

/**
 * Required services (cordis fiber inject).
 *
 * `remote.commands` 必须显式声明，即使 `remote` 已经在列表里：远端命名空间是
 * 各自独立的 Cordis 服务（`remote.<namespace>`），反射代理按**完整服务名**判定
 * 注入，少写一个就在读取的那一刻抛「cannot get property … without inject」。
 * 这里曾经漏掉它——"总结错误经验"按钮直接报无法运行——而 `remote` 这一项看起来
 * 又像是已经覆盖了所有远端调用，所以这类漏项在 review 里很不容易被看见。
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.commands', 'remote.credentials', 'remote.session',
  'remote.skills', 'remote.settings', 'sessions', 'settingsScope',
]

/**
 * Mount the plugin configuration section and the cards this package ships.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugins: section dictionaries')

  const bash = new BashCardController(ctx.settingsScope.bind({ namespace: SHELL_NS }))
  const agentLoop = new AgentLoopCardController(ctx.settingsScope.bind({ namespace: AGENT_LOOP_NS }))
  const webSearch = new WebSearchCardController(
    ctx.settingsScope.bind({ namespace: WEB_SEARCH_NS }), ctx)
  const currentSessionId = (): SessionId | undefined => {
    const snapshot = ctx.sessions.list.getSnapshot()
    if (snapshot.current !== undefined) return snapshot.current
    return snapshot.ids?.find(id => snapshot.byId?.[id]?.origin !== 'subagent')
  }
  const currentWorkspace = (): string | undefined => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const sessionId = currentSessionId()
    return sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd
  }
  const skillTrigger = new SkillTriggerCardController(
    ctx.settingsScope.bind({ namespace: SKILL_FILESYSTEM_NS }),
    {
      loadSkills: async (sessionId) => {
        const locale = ctx.locale.getSnapshot?.()?.active
        const result = await ctx.remote.skills.list({
          sessionId,
          ...(locale === undefined ? {} : { locale }),
        })
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value.skills
      },
      workspace: () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        const sessionId = currentSessionId()
        return sessionId === undefined ? undefined : snapshot.byId[sessionId]?.cwd
      },
      sessionId: currentSessionId,
    },
  )
  ctx.effect(() => {
    const dispose = ctx.sessions.list.subscribe(() => { skillTrigger.refresh() })
    skillTrigger.refresh()
    return dispose
  }, 'ui-settings-plugins: skill catalog session sync')
  const llmRetry = new LlmRetryCardController(ctx.settingsScope.bind({ namespace: LLM_DEEPSEEK_NS }))
  const promptOverrides = new PromptOverridesCardController(
    ctx.settingsScope.bind({ namespace: SYSTEM_PROMPT_OVERRIDES_NS }),
    {
      workspace: currentWorkspace,
      readPromptSections: async (workspace) => {
        // 参数必须显式传：远端方法按位置对账实参个数，省略可选参数会被当成
        // "少传了一个"。传 `undefined` 正是"没有工作区"的约定写法。
        const response = await ctx.remote.settings.readPromptSections(workspace)
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        return response.value
      },
      readToolErrors: async () => {
        const response = await ctx.remote.settings.readToolErrors()
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        return response.value
      },
      readReflections: async () => {
        const response = await ctx.remote.settings.readReflections()
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        return response.value
      },
      writeReflections: async (blocks) => {
        // 控制器交出来的是只读快照；RPC 参数是可变的，复制一层再送出去。
        const response = await ctx.remote.settings.writeReflections([...blocks])
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
      },
      // "总结错误经验"不在这里实现：仓库已有的 `/correct-errors` 命令负责融合、
      // 归档（只追加）与清空，这里只把它送进当前会话——两个入口维护同一份文档
      // 迟早会漂移，所以按钮只做"按下"。
      canRunCorrection: () => currentSessionId() !== undefined,
      runCorrection: async () => {
        const sessionId = currentSessionId()
        if (sessionId === undefined) throw new Error('no session is open to run /correct-errors in')
        // 必须走命令通道 `commands/execute`。曾用 `session.prompt` 把
        // "/correct-errors" 当普通消息发出去，结果它只是被当成聊天内容送进模型，
        // 命令一次都没执行（模型对着这行字白跑了好几轮工具调用）。
        const response = await ctx.remote.commands.execute(sessionId, '/correct-errors', [])
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        const execution = response.value
        if (execution === undefined) throw new Error('/correct-errors is not available in this session')
        if (execution.result.kind === 'error') throw new Error(execution.result.text)
        // 命令自己的回执（"没有可纠正的错误" / "子代理已启动"）交给卡片原样显示。
        return execution.result.text
      },
    },
  )
  ctx.effect(() => {
    const dispose = ctx.sessions.list.subscribe(() => { void promptOverrides.refresh() })
    void promptOverrides.refresh()
    return dispose
  }, 'ui-settings-plugins: prompt section session sync')
  const subagentModelSelection = new SubagentModelSelectionCardController(
    ctx.settingsScope.bind({ namespace: SUBAGENT_MODEL_SELECTION_NS }),
    ctx,
  )

  // The credential a card reports is not part of any settings section, so its
  // scope publishes nothing when one is written. This is the only signal that
  // a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { webSearch.refreshCredential(ref) }),
    'ui-settings-plugins: credential invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { subagentModelSelection.refreshCatalog() }),
    'ui-settings-plugins: subagent adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { subagentModelSelection.refreshCatalog() }),
    'ui-settings-plugins: subagent settings invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { subagentModelSelection.resetConnection() }),
    'ui-settings-plugins: subagent connection generation',
  )
  ctx.effect(() => () => { subagentModelSelection.dispose() }, 'ui-settings-plugins: subagent preference')

  // The shared SettingsScope mirror updates after document commits and reconnects.
  const configurable = new ConfigurablePluginsTabController(
    ctx.settingsScope.describe(), () => ctx.slots.entries('settings.plugin.item'))
  ctx.effect(() => () => { configurable.dispose() }, 'ui-settings-plugins: tab directory')
  // A card registered after the first read joins the list without a wire call.
  ctx.effect(
    () => ctx.slots.subscribe('settings.plugin.item', () => { configurable.refresh() }),
    'ui-settings-plugins: card ledger',
  )

  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly PluginsSettingsTabEntry[] = []
  const sectionInjected = (): PluginsSettingsSectionInjected => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.plugins.tab')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== tabsVersion || revision !== tabsRevision) {
            tabsVersion = version
            tabsRevision = revision
            tabs = ctx.slots.entries('settings.plugins.tab')
              .map(entry => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.plugins.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
    },
  })

  // This package owns the one Plugins navigation entry and the tab chrome;
  // feature plugins contribute pages without competing for Settings nav rows.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: () => t('nav'),
    locale: NS,
    inject: sectionInjected,
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginsSettingsSection))

  // The existing configuration page is one ordinary tab. It keeps ownership
  // of the card slot and the shipped card contributions below.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'configurable',
    order: 0,
    label: () => t('configurableTab'),
    locale: NS,
    inject: () => configurable.inject(),
    children: { 'settings.plugin.item': { kind: 'keyed', scope: 'root' } },
  }, ConfigurablePluginsTab))

  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SHELL_NS,
      locale: NS,
      inject: () => bash.inject(),
    }, BashCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: AGENT_LOOP_NS,
      locale: NS,
      inject: () => agentLoop.inject(),
    }, AgentLoopCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SUBAGENT_MODEL_SELECTION_NS,
      locale: NS,
      inject: () => subagentModelSelection.inject(),
    }, SubagentModelSelectionCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: WEB_SEARCH_NS,
      locale: NS,
      inject: () => webSearch.inject(),
    }, WebSearchCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SKILL_FILESYSTEM_NS,
      locale: NS,
      inject: () => skillTrigger.inject(),
    }, SkillTriggerCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: LLM_DEEPSEEK_NS,
      locale: NS,
      inject: () => llmRetry.inject(),
    }, LlmRetryCard)
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: SYSTEM_PROMPT_OVERRIDES_NS,
      locale: NS,
      inject: () => promptOverrides.inject(),
    }, PromptOverridesCard)
  })
}
