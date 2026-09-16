/**
 * Mounts the optional settings section for UI-authored prompt replacements,
 * and bridges the interface language the user picked onto the prompt registry
 * so prompt sections and the skill catalog render in that language.
 *
 * It is separate from the prompt registry so a deployment without settings can
 * still use the registry, while a deployment with settings can edit prompt text
 * from the browser and have the next request see the new values.
 *
 * @module @deepseek-ai/dsh-system-prompt/overrides
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PromptOverridesSettingsInstaller, SystemPrompt } from './index.ts'

/** Cordis plugin name. */
export const name = 'system-prompt-overrides'

/** Services required to bridge the prompt registry onto settings. */
export const inject = ['systemPrompt', 'settings']

/** Default settings namespace owning the interface language preference. */
export const DEFAULT_LOCALE_NAMESPACE = 'locale'

/** Default field carrying the interface language tag inside that namespace. */
export const DEFAULT_LOCALE_FIELD = 'preference'

/** Plugin configuration. */
export interface Config {
  /** Settings namespace holding the interface language. */
  localeNamespace?: string
  /** Field inside that namespace carrying the language tag. */
  localeField?: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  localeNamespace: z.string().min(1).default(DEFAULT_LOCALE_NAMESPACE),
  localeField: z.string().min(1).default(DEFAULT_LOCALE_FIELD),
})

/** Host shape this plugin reaches through. */
interface Host {
  systemPrompt: SystemPrompt
  settings: PromptOverridesSettingsInstaller
}

/**
 * Read the interface language tag out of the settings document.
 *
 * 三个失败方向都回落到"没有语言"而不是抛错：设置服务还没发布文档、命名空间
 * 由另一个插件稍后才注册、字段被用户写成非字符串——这些都只是"这一刻读不到
 * 语言"，提示词照常装配，只是保持内置英文文案。语言是装饰，不该有把一次会话
 * 打断的能力。
 *
 * @param settings - settings provider (or a minimal stand-in).
 * @param ns - namespace to read.
 * @param field - field inside that namespace.
 * @returns the language tag, or `undefined` when it cannot be read.
 */
export function readLocalePreference(
  settings: PromptOverridesSettingsInstaller,
  ns: string,
  field: string,
): string | undefined {
  const section = settings.get?.(ns)
  if (section === null || typeof section !== 'object') return undefined
  const value = (section as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * Install the prompt-overrides settings section and wire the interface language.
 * @param ctx - host context carrying the prompt registry and settings service.
 * @param config - namespace and field of the interface language setting.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const host = ctx as unknown as Host
  host.systemPrompt.installOverrides(ctx, host.settings)
  const ns = config.localeNamespace ?? DEFAULT_LOCALE_NAMESPACE
  const field = config.localeField ?? DEFAULT_LOCALE_FIELD
  host.systemPrompt.adoptLocaleSource(() => readLocalePreference(host.settings, ns, field))
}
