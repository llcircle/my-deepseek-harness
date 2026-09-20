/**
 * Registry for ordered system sections, dynamic context, tool schemas, and prompt variables.
 *
 * @module @deepseek-ai/dsh-system-prompt
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer, Scoped } from '@deepseek-ai/dsh-scope'
import type { ContextSnapshotSection, ToolSchema } from '@deepseek-ai/dsh-llm'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { localizedSectionText } from './localized-sections.ts'

export {
  localizedSectionNames, localizedSectionText, LOCALIZED_SECTIONS,
  type LocalizedSectionEntry, type LocalizedSections,
} from './localized-sections.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }

  interface Events {
    /**
     * Expert waterfall over the assembled sections, contexts, tools, and variables.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
     * receive only that scope's assemblies. The returned value is authoritative.
     * A supplied signal controls only this explicit assembly request and must not
     * be retained to control later turns. A registered complete section is
     * restored after this waterfall, so listeners cannot add to or replace
     * that scope's system prompt.
     * @param assembly - the mutable assembly built from registered providers.
     * @param context - the caller's per-assembly context.
     * @mode waterfall
     */
    'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
    /**
     * Emitted when any prompt provider changes. This registry notification is
     * unfiltered because a global change affects every scope.
     * @mode emit
     */
    'system-prompt/change'(): void
  }
}

/** A selectable system-prompt language. */
export type PromptLocale = 'zh' | 'en'

/**
 * The values a language setting can come from. `auto` follows the interface
 * language the user picked in settings; `zh`/`en` are locked explicitly by the
 * deployment and stop following settings.
 */
export type PromptLocalePreference = 'auto' | PromptLocale

/** 全部可选语言，用于 Schema 与穷举检查。 */
export const PROMPT_LOCALES = ['zh', 'en'] as const

/** 语言偏好的全部取值，用于 Schema。 */
export const PROMPT_LOCALE_PREFERENCES = ['auto', 'zh', 'en'] as const

/**
 * 把界面语言标签归一到系统提示词认识的语言。
 *
 * 界面语言是开放的 BCP 47 标签（`zh`、`zh-CN`、`zh-Hans-CN`…），而提示词只有
 * 两套成品文案，所以这里只看主子标签：任何 `zh*` 都是中文，其余一律英文。
 * 归一放在这里而不是要求调用方传规范值，是因为设置里存的是用户浏览器写的原样标签。
 *
 * @param preference - 界面语言标签或语言偏好；空值与未知值都回落到 `en`。
 * @returns `zh` 或 `en`。
 */
export function normalizePromptLocale(preference: string | undefined): PromptLocale {
  if (preference === undefined) return 'en'
  const trimmed = preference.trim()
  if (trimmed === '') return 'en'
  const primary = trimmed.split('-')[0]?.toLowerCase()
  return primary === 'zh' ? 'zh' : 'en'
}

/** Merge-extensible context for one prompt assembly. */
export interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Session workspace used to resolve per-session prompt file configuration. */
  cwd?: string
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
  /**
   * The active language for this assembly, written by the registry once it resolves one.
   * Sections and context providers pick their wording from it; callers neither need nor
   * should pass it themselves.
   */
  locale?: PromptLocale
}

/** One contributed section of the system prompt (registry input). */
export interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Equal orders use code-unit
   * name order.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}, unless `interpolate` is false.
   */
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  /**
   * The abilities under this section that each keep their own lessons, one
   * reflection-document subject key apiece (see {@link PromptReflectionSource}).
   *
   * An MCP server owns one prompt section but a dozen tools. A tool's lessons
   * belong inside its server's section, yet the editing surface has to know
   * which tools sit under it — otherwise it could only offer one field for the
   * whole section. Declared here, the surface expands one section into several
   * rows, so editing one tool's lessons cannot touch another's.
   *
   * Omitted means the section has no sub-subjects, as almost every section is.
   */
  readonly subjects?: (context: AssembleContext) => readonly string[]
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
}

/** Dynamic model context materialized as a durable user-role snapshot. */
export interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
}

/** One section of an assembly: {@link PromptSection} with its text resolved. */
export interface AssembledSection {
  /** The contributing section's unique name. */
  name: string
  /** The resolved (but not yet interpolated) section text. */
  text: string
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  interpolate?: boolean
}

/** One resolved dynamic context contribution. */
export interface AssembledContext {
  /** The contributing context's unique name. */
  name: string
  /** The resolved text before variable interpolation. */
  text: string
}

/** Tool schemas visible in one assembly and their pre-restriction name set. */
export interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}

/**
 * Merge-extensible assembled model input. Sections and contexts remain
 * uninterpolated until rendered; tools are already in canonical order.
 */
export interface PromptAssembly {
  sections: AssembledSection[]
  contexts: AssembledContext[]
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
  /**
   * 本次装配生效的语言。渲染函数靠它选框架文案；手工构造的装配（测试、
   * 离线渲染）省略时按 `zh` 处理，与该函数既有行为一致。
   */
  locale?: PromptLocale
}

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  TEAM_POLICY: 600,
  PTC_ONLY: 800,
  FILE_REFERENCE: 900,
  TOOL_BASH: 1000,
  TOOL_PWSH: 1010,
  TOOL_READ: 1100,
  TOOL_WRITE: 1200,
  TOOL_EDIT: 1300,
  TOOL_GLOB: 1400,
  TOOL_GREP: 1500,
  TOOL_JOBS: 1600,
  TOOL_PTY: 1700,
  TOOL_WEB_SEARCH: 2000,
  TOOL_WEB_FETCH: 2100,
  TOOL_LSP: 2200,
  TOOL_SESSION_QUERY: 2300,
  TOOL_GOAL: 2400,
  TOOL_CORDIS: 2500,
  TOOL_WORKFLOW: 2600,
  TOOL_RALPH: 2700,
  TOOL_SUBAGENT: 2800,
  TOOL_REPORT: 2900,
  // 按需工具的索引紧跟在全部工具用法之后：它是一句"上面还差几个"的补充，
  // 放在工具说明中间会让"这个工具怎么用"的阅读被打断。
  TOOLS_ON_DEMAND: 2950,
  TOOL_COMPUTER_USE: 3000,
  // 上游把"哪些 MCP 服务器可读资源"与"每台服务器自己的介绍"都放在这里，两节相邻。
  // fork 把后者移到了 MCP_INTRO（见其注释），前者跟着一起搬——留着这个位置只会让
  // 两份 MCP 材料被提示词中段的其它段落劈开。
  MCP_SERVERS: 3100,
  TOOLS_SDK: 5000,
  DELIVERABLE_FILE_REFERENCES: 9000,
  MCP_INTRO: 9050,
  // 电脑操作策略紧挨 MCP 介绍：两者都是"本会话额外装配进来的能力说明"，
  // 放在提示词尾部可以让身份、人格与工具用法保持在前，不被这段长文挤开。
  COMPUTER_USE_POLICY: 9060,
  ERROR_LESSONS: 9100,
  STRUCTURED_OUTPUT: 9900,
  // Local paths and endpoints follow reusable instructions.
  HARNESS_SOURCE: 10000,
  WEB_SURFACE: 10100,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
  // 技能目录排在最后：它是"有哪些技能可用"的清单，与任何一节的用法说明都无耦合，
  // 放在尾部既不打散工具用法，也方便整体替换成译文。
  SKILL_CATALOG: 10300,
} as const

/** Name of a centrally allocated prompt-section position. */
export type PromptSectionOrderName = keyof typeof SECTION_ORDERS

const CONTEXT_ORDERS = {
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
  // 电脑操作策略先以运行时上下文的形式留在消息尾部，直到下一次压缩（缓存本来就要
  // 重建的时刻）才提升成常驻分段。它与 MCP 介绍同族——都是"本会话额外装配进来的
  // 能力说明"——只是暂时走尾部通道，所以位置排在运行时上下文族之后、与
  // `COMPUTER_USE_POLICY` 分段（9060）各自独立编号。
  COMPUTER_USE_POLICY: 130,
} as const

/** Name of a centrally allocated runtime-context position. */
export type PromptContextOrderName = keyof typeof CONTEXT_ORDERS

/**
 * The deployment persona prefix's section name. Exported because a
 * composition can replace this slot — an agent preset shadows the
 * deployment's persona with its own — and both sides naming the same section
 * is what makes the replacement work rather than duplicate.
 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** Deployment persona suffix section name shared by global and scoped contributions. */
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** Valid variable names: how they are written between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** A complete `{{...}}` reference group at the scan position (validated after). */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** Reserved {@link Config.toolOrder} marker for unlisted tools. */
export const TOOL_ORDER_REST = '<unlisted-tools>'
/** Default per-session translation-only prompt from `/translate-system-prompt`. */
const DEFAULT_TRANSLATED_PROMPT_FILE = '.dsh/system-prompt.zh.prompt.md'

/** Settings namespace for UI-authored system-prompt replacements. */
export const SYSTEM_PROMPT_OVERRIDES_SETTINGS_NAMESPACE = 'system-prompt-overrides'

/** One section's language-separated replacement. */
export interface PromptLocaleOverride {
  /** Simplified Chinese replacement; empty keeps the provider text. */
  readonly zh: string
  /** English replacement; empty keeps the provider text. */
  readonly en: string
}

/**
 * Runtime-editable system-prompt section replacements.
 *
 * 这里没有"当前语言"字段：替换文本送哪一种语言，由界面语言设置
 * (`locale.preference`) 经 {@link SystemPrompt.activeLocale} 决定，与装配出的
 * 其他分段同源。让设置里再存一个语言开关，就会出现"提示词按 A 语言装配、
 * 覆盖按 B 语言应用"的半中半英结果。
 *
 * 也没有 MCP 介绍专属字段：每个 MCP 服务器是一个普通分段（`mcp:<serverName>`，
 * 由挂载它的 mcp-client 实例注册），和其余分段一样通过 {@link sections} 覆盖，
 * 不再有第二条写入路径。
 */
export interface PromptOverridesSettings {
  /** Section names offered by the editing UI. */
  readonly sectionCatalog: readonly string[]
  /** Per-section replacements keyed by the original section name. */
  readonly sections: Readonly<Record<string, PromptLocaleOverride>>
}

/**
 * 逐分段的"经验追加"来源：给定分段名，返回要追加到该分段正文之后的一段文本。
 *
 * 有了它，工具失败反思才能落在它真正属于的地方——`tool:read` 的教训接在 `read`
 * 的用法说明后面，而不是挤在一节全局的"过往教训"里让模型自己去对号入座。返回
 * `undefined` 或空白表示这个分段没有经验可加。
 *
 * 追加发生在用户覆盖之后、可选分段判空之前：覆盖改的是"介绍"，反思是独立的一
 * 层，两者互不吞掉对方；而"介绍为空的分段不追加"这一条保证了未启用的能力不会
 * 因为文档里还留着它的旧经验就被重新拉回提示词。
 */
export type PromptReflectionSource = (sectionName: string) => string | undefined

/** One prompt section projected for editing surfaces. */
export interface PromptSectionView {
  /** Stable section name. */
  readonly name: string
  /** Current English provider text; empty when unavailable. */
  readonly en: string
  /** Current Chinese text from the project archive; empty when unavailable. */
  readonly zh: string
  /** Whether the section accepts UI-authored text replacement. */
  readonly editable: boolean
  /**
   * The abilities under this section that each keep their own lessons (the
   * evaluated {@link PromptSection.subjects}), one reflection-document subject
   * key apiece. An empty array means the section is a single row of its own.
   */
  readonly subjects: readonly string[]
}

/** Schema for {@link PromptOverridesSettings}. */
export const PromptOverridesSettingsSchema = z.object({
  sectionCatalog: z.array(z.string()).default([]),
  sections: z.dict(z.object({
    zh: z.string().default(''),
    en: z.string().default(''),
  })).default({}),
})

const DEFAULT_PROMPT_OVERRIDES: PromptOverridesSettings = {
  sectionCatalog: [],
  sections: {},
}

/** Editing UI catalog for first-party sections; custom names can still be added. */
const DEFAULT_SECTION_CATALOG = [
  'harness:identity',
  'harness:source',
  'app:web-surface',
  'deployment:persona-prefix',
  'deployment:persona-suffix',
  'deployment:error-lessons',
  'context:file-reference',
  'tool:pwsh',
  'tool:read',
  'tool:write',
  'tool:edit',
  'tool:glob',
  'tool:grep',
  'tool:jobs',
  'tool:web_search',
  'tool:web_fetch',
  'tool:goal',
  'tool:goal:merged',
  'tool:workflow',
  'tool:ralph',
  'tool:subagent',
  'tool:subagent:merged',
  'tool:subagent_fork',
  'tool:jobs:merged',
  'tools:on-demand',
  'ui:deliverable-file-references',
  'skills:catalog',
]

/**
 * Sections whose provider text is dynamic and must not be replaced from Web.
 *
 * `computer:policy` 属于这里：它的正文是部署给出的安全边界（屏幕内容是证据不是指令、
 * 不可逆操作必须先取得用户同意），不是一段可供润色的措辞。允许在界面上整体替换它，
 * 等于给用户一个"把护栏改掉"的输入框；部署要定制措辞有 `policy` 配置这一层，
 * 用户要写的是挂在它后面的**反思**。它作为能力的定位与 MCP 服务器一致：
 * 介绍由部署给出，用户写的是挂在介绍后半页的经验。
 */
const NON_EDITABLE_SECTION_NAMES = new Set([
  'deployment:error-lessons',
  'skills:catalog',
  'computer:policy',
])

/**
 * 空文本即整段消失的分段。
 *
 * 名单刻意是显式的而不是"所有空分段都丢掉"：多数分段注册后即使暂时为空也
 * 要留在装配结果里——`tool:subagent` 靠"存在但为空"表达"工具当前不可用，
 * 这一节仍由它拥有"，消费方据此区分"没装载"与"装载了但没话说"。而这里的
 * 分段恰恰相反：它们的内容完全由"这次装配里到底有没有这个能力"决定，留一个
 * 空条目只会让提示词多出一节空壳。
 *
 * 注意这层防御与"未启用就没注册"是两件事，不要拿其中一个去替换另一个：
 * `computer:policy` 现在由 tool-computer-use 在启用时才注册，正常情况下轮不到
 * 这里过滤；但分段可以有多个注册方，判空兜住的是"注册了却决定自己没话可说"
 * 这一情形（`deployment:error-lessons` 就是这种），不能因为主要路径已经不空
 * 就把名单收窄。
 */
const OPTIONAL_SECTION_NAMES = new Set([
  'computer:policy',
  'deployment:error-lessons',
])

/**
 * 每挂一个 MCP 服务器就多一个 `mcp:<serverName>` 分段，名字是运行期才知道的，
 * 所以只能按前缀判——把它们一个个写进名单，等于要求名单跟着 cordis.yml 走。
 * @param name - 分段名。
 * @returns 该分段是否属于"空即消失"的那一类。
 */
function isOptionalSection(name: string): boolean {
  return OPTIONAL_SECTION_NAMES.has(name) || name.startsWith('mcp:')
}

/**
 * 把每个反思来源给出的文本追加到它认领的分段之后。
 *
 * **只追加到本身已有内容的分段上。** 这是"未启用的能力不显示介绍和反思"的落点。
 * 能力的缺席通常由注册方表达（`computer:policy` 只在启用时注册，MCP 服务器只在
 * 连上时注册），那时这里压根轮不到判空；这一层兜的是另一类情形——分段存在、但
 * 本次装配它自己没话可说（例如 `deployment:error-lessons` 还没有任何经验）。
 * 两种情况的结果一致且都必须成立：文档里哪怕还留着上一次的经验，也不该靠反思
 * 把一节空壳拽回提示词。
 *
 * @param assembly - 已经应用过语言覆盖的装配结果。
 * @param sources - 本次装配可见的反思来源，按注册顺序。
 * @returns 追加后的装配；没有可追加内容时原样返回。
 */
function applyReflections(
  assembly: PromptAssembly,
  sources: readonly PromptReflectionSource[],
): PromptAssembly {
  if (sources.length === 0) return assembly
  return {
    ...assembly,
    sections: assembly.sections.map((section) => {
      if (section.text.trim() === '') return section
      const appended = sources
        .map(source => source(section.name))
        .filter((text): text is string => text !== undefined && text.trim() !== '')
      if (appended.length === 0) return section
      return { ...section, text: [section.text, ...appended.map(text => text.trim())].join('\n\n') }
    }),
  }
}

/**
 * 丢掉最终文本为空白、且属于 {@link OPTIONAL_SECTION_NAMES} 的分段。
 *
 * 判定用的是"覆盖之后"的文本：可选分段的注册文本可以是空的，它们在编辑界面里
 * 被填上内容才算数。这个函数因此只能在 {@link SystemPrompt.applyOverrides} 之后
 * 调用，顺序颠倒就会让用户刚写好的分段凭空消失。
 *
 * @param assembly - 已经应用过语言覆盖的装配结果。
 * @returns 同一个装配，去掉空白的可选分段；没有可丢的条目时原样返回。
 */
function dropEmptyOptionalSections(assembly: PromptAssembly): PromptAssembly {
  const sections = assembly.sections.filter(
    section => section.text.trim() !== '' || !isOptionalSection(section.name),
  )
  return sections.length === assembly.sections.length ? assembly : { ...assembly, sections }
}

/** Minimal shape needed to install the optional runtime-editable overrides section. */
export type PromptOverridesSettingsInstaller = {
  installSection(
    owner: Context,
    ns: typeof SYSTEM_PROMPT_OVERRIDES_SETTINGS_NAMESPACE,
    schema: typeof PromptOverridesSettingsSchema,
    entry: PromptOverridesSettings,
    hooks: {
      setSource: (current: () => PromptOverridesSettings) => void
      onChange: () => void
    },
  ): void
  /**
   * 读取另一个已注册命名空间的当前值；未注册时返回 `undefined`。
   *
   * 语言不在本插件自己的命名空间里，而在界面语言那一份设置中。注册表不该
   * 为了读一个字段就去依赖设置服务，所以由装配方把这个只读能力递进来。
   */
  get?(ns: string): unknown
}

/** Section names whose provider output stays live instead of using the translated archive. */
const DYNAMIC_SECTION_NAMES = new Set(['skills:catalog', 'deployment:error-lessons'])

/**
 * Validate duplicate names and the required {@link TOOL_ORDER_REST} marker.
 * Registered names are checked later because plugins have not loaded yet.
 */
function validateToolOrder(toolOrder: string[] | undefined): string[] | undefined {
  if (toolOrder === undefined) return undefined
  const seen = new Set<string>()
  for (const name of toolOrder) {
    if (seen.has(name)) throw new Error(`toolOrder lists "${name}" more than once`)
    seen.add(name)
  }
  if (!seen.has(TOOL_ORDER_REST)) {
    throw new Error(`toolOrder must contain the "${TOOL_ORDER_REST}" rest entry (where unlisted tools are inserted)`)
  }
  return toolOrder
}

/**
 * Apply configured tool order, inserting unlisted tools lexicographically at
 * {@link TOOL_ORDER_REST}. Unknown configured names fail; known but restricted
 * names may be absent.
 */
function orderTools(tools: ToolSchema[], toolOrder: string[] | undefined, knownNames: ReadonlySet<string>): ToolSchema[] {
  const reserved = tools.find(tool => tool.name === TOOL_ORDER_REST)
  if (reserved !== undefined) {
    throw new Error(`tool provider returned reserved tool name "${TOOL_ORDER_REST}" (reserved for toolOrder's rest entry)`)
  }
  if (toolOrder === undefined) return tools.sort(compareToolNames)
  const unknown = toolOrder.filter(name => name !== TOOL_ORDER_REST && !knownNames.has(name))
  if (unknown.length > 0) {
    throw new Error(`toolOrder lists unregistered tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => `"${name}"`).join(', ')}; known tools: ${[...knownNames].sort().join(', ') || '(none)'}`)
  }
  const listed = new Set(toolOrder)
  const rest = tools.filter(tool => !listed.has(tool.name)).sort(compareToolNames)
  return toolOrder.flatMap(name =>
    name === TOOL_ORDER_REST ? rest : tools.filter(tool => tool.name === name))
}

/** Code-unit name comparison — locale-independent, so the order is identical on every machine. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Order prompt sections by their explicit placement, then deterministically by name. */
function comparePromptSections(a: PromptSection, b: PromptSection): number {
  return a.order - b.order || compareNames(a.name, b.name)
}

/** Order tool schemas lexicographically by name. */
function compareToolNames(a: ToolSchema, b: ToolSchema): number {
  return compareNames(a.name, b.name)
}

/**
 * Split a translated archive into non-empty blank-line paragraphs.
 * Sections are translated one paragraph at a time, so paragraphs are the
 * smallest stable matching unit. Skill-catalog paragraphs are skipped because
 * that section stays live; the live catalog owns the latest skill summaries.
 */
function translatedParagraphs(translated: string): string[] {
  return translated.replaceAll(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '' && !paragraph.includes('<available_skills>'))
}

/**
 * Match source sections to translated paragraphs and produce one translated
 * section per matched source, keyed by its original section name. Live
 * catalog and lessons sections stay dynamic; complete sections own the entire
 * prompt.
 * @param sections - assembled source sections before replacement.
 * @param translated - the complete translated archive text.
 * @returns translated sections keyed by source section name.
 */
function mapTranslatedSections(
  sections: ReadonlyArray<{ name: string; text: string; complete?: boolean }>,
  translated: string,
): Map<string, string> {
  const paragraphs = translatedParagraphs(translated)
  const translatedByName = new Map<string, string>()
  const sourceParagraphs = sections.flatMap((section) => {
    if (
      DYNAMIC_SECTION_NAMES.has(section.name)
      || section.complete === true
      || section.text.trim() === ''
    ) return []
    return section.text.split('\n\n').map(paragraph => ({ name: section.name, paragraph }))
  })
  const count = Math.min(paragraphs.length, sourceParagraphs.length)
  for (const [index, source] of sourceParagraphs.slice(0, count).entries()) {
    const paragraph = paragraphs[index]
    if (paragraph === undefined) continue
    const previous = translatedByName.get(source.name)
    translatedByName.set(source.name, previous === undefined ? paragraph : `${previous}\n\n${paragraph}`)
  }
  return translatedByName
}

/**
 * 按语言替换一个分段的文案。
 *
 * 三处刻意保守的决定：
 * 1. `complete` 分段与动态分段（`skills:catalog`、`deployment:error-lessons`）不碰——
 *    前者整段就是提示词本身，后者的文本是运行期现算的，替换会盖掉最新内容。
 * 2. 当前为空的分段保持为空。空是"这一节现在没有话要说"，不是"该说默认文案了"，
 *    把空段填上会让"未启用"的能力看起来像是启用了。
 * 3. 动态片段抽不出来时保留原文——见 {@link localizedSectionText}。
 *
 * @param section - 待本地化的分段。
 * @param locale - 目标语言。
 * @returns 本地化后的分段；无需改动时原样返回。
 */
function localizeSection(section: PromptSection, locale: PromptLocale): PromptSection {
  if (section.complete === true) return section
  if (DYNAMIC_SECTION_NAMES.has(section.name)) return section
  const base = section.text
  const source = typeof base === 'function' ? base : () => base
  // 先求值一次只为判断"这一节有没有内容"，真正的替换发生在装配时。
  const probe = typeof base === 'string' ? base : ''
  if (typeof base === 'string') {
    const localized = localizedSectionText(section.name, probe, locale)
    if (localized === undefined || probe.trim() === '') return section
    return { ...section, text: localized }
  }
  return {
    ...section,
    text: (context) => {
      const original = source(context)
      if (original.trim() === '') return ''
      return localizedSectionText(section.name, original, locale) ?? original
    },
  }
}

/** Plugin config: the deployment-authored fragment of the system prompt (see {@link Config.personaPrefix} for its contract). */
export interface Config {
  /** Include the fixed DeepSeek Harness identity before the deployment persona (default true). */
  includeHarnessIdentity?: boolean
  /**
   * Absolute path to a UTF-8 file whose whole content replaces the assembled
   * system prompt sections (the tools, contexts, and variables still resolve).
   * At construction a missing file means "not configured" — the standard
   * assembly runs; any other read failure fails the plugin at load. Once
   * active, the file is re-read per assembly and its disappearance fails that
   * request loudly rather than silently downgrading the prompt.
   */
  completePromptFile?: string
  /**
   * Use the per-session translation-only prompt produced by
   * `/translate-system-prompt` (default true). A relative
   * {@link Config.translatedPromptFile} resolves against the assembling agent's
   * session workspace; a missing file leaves the standard assembly untouched.
   */
  autoTranslatedPrompt?: boolean
  /** Include dynamic runtime-context snapshots in model history (default true). */
  includeRuntimeContext?: boolean
  /**
   * Deployment-wide persona prefix template before first-party guidance. A scoped section named
   * `deployment:persona-prefix` shadows it; `{{variable}}` references are strict.
   */
  personaPrefix?: string
  /**
   * Persona suffix template after first-party guidance. A scoped `deployment:persona-suffix`
   * section shadows it; `{{variable}}` references are strict. Defaults to empty.
   */
  personaSuffix?: string
  /**
   * Per-session translation-only prompt file. Relative paths resolve against
   * the assembling agent's session workspace (default
   * `.dsh/system-prompt.zh.prompt.md`, the `/translate-system-prompt` output).
   */
  translatedPromptFile?: string
  /**
   * System-prompt language (`auto` by default). `auto` follows the interface
   * language the user picked in settings; `zh`/`en` are locked by the
   * deployment and stop following settings — for pinning one deployment to a
   * single language.
   *
   * It only picks the wording of built-in sections and the skill catalog;
   * section overrides the user writes in the settings card always take effect
   * in that card's own language, unaffected by this.
   */
  promptLocale?: PromptLocalePreference
  /**
   * Model-facing tool names in order, with {@link TOOL_ORDER_REST} exactly once.
   * Invalid fields fail at load and unknown names fail at assembly; known names
   * hidden in one scope may be absent there. Omitted means lexicographic order.
   */
  toolOrder?: string[]
}

/**
 * Interpolate strict `{{variable}}` references, drop empty sections, and join
 * the rest with blank lines. Sections with `interpolate: false` retain literal
 * text. Malformed, unknown, or undefined references in other sections throw;
 * a lone `{{` without any later `}}` is literal prose, and substituted values
 * are not scanned again.
 * @param assembly - the assembly whose sections and variables to render.
 * @returns the rendered prompt, or `''` when all sections are empty.
 */
export function renderPromptSections(assembly: PromptAssembly): AssembledSection[] {
  return assembly.sections
    .map(section => ({
      name: section.name,
      text: section.interpolate === false ? section.text : interpolate(section, assembly.variables, 'section'),
    }))
    .filter(section => section.text.length > 0)
}

/**
 * Render the complete system prompt: every non-empty section joined in order.
 * @param assembly - the assembly whose sections and variables to render.
 * @returns the model-facing prompt text, or `''` when no section renders to text.
 */
export function renderPrompt(assembly: PromptAssembly): string {
  return renderPromptSections(assembly)
    .map(section => section.text)
    .join('\n\n')
}

/**
 * Render the complete dynamic context snapshot.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function renderContextSnapshot(assembly: PromptAssembly): string {
  return joinContextSections(renderContextSections(assembly), assembly.locale ?? 'zh')
}

/**
 * Snapshot heading. It shares one model message with the policy prose, so the
 * language must match.
 */
const CONTEXT_SNAPSHOT_HEADING: Record<PromptLocale, string> = {
  zh: '当前运行时上下文。此快照取代较早的运行时上下文快照。',
  en: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
}

/**
 * Snapshot body used once no dynamic context remains. It answers the heading
 * above in the same message, so it draws its language from the same locale.
 */
const CONTEXT_SNAPSHOT_CLEARED: Record<PromptLocale, string> = {
  zh: '当前运行时上下文：无。较早的运行时上下文快照不再生效。',
  en: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.',
}

/**
 * The model-facing body that clears a stale runtime-context snapshot, in the
 * language the accompanying heading is written in.
 *
 * A loop that joins sections through {@link joinContextSections} passes the
 * same locale here; hardcoding one language would leave a Chinese heading
 * announcing an English withdrawal.
 * @param locale - locale picking the wording; defaults to `zh`, matching the
 *   {@link joinContextSections} default so callers that pass no locale keep a
 *   single-language snapshot.
 * @returns the cleared-snapshot body for that locale.
 */
export function contextSnapshotCleared(locale: PromptLocale = 'zh'): string {
  return CONTEXT_SNAPSHOT_CLEARED[locale]
}

/**
 * The model-facing snapshot text for an already-rendered section list.
 *
 * A caller that also needs the sections renders them once and joins here, so a
 * request does not interpolate every context twice.
 * @param sections - sections from {@link renderContextSections}.
 * @param locale - locale picking the heading; defaults to `zh` to preserve the
 * behaviour hand-built assemblies (offline renders, older callers) received
 * before a locale existed — an assembled `assembly` always passes its own.
 * @returns the current full snapshot, or `''` when no context is active.
 */
export function joinContextSections(
  sections: readonly ContextSnapshotSection[],
  locale: PromptLocale = 'zh',
): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `${CONTEXT_SNAPSHOT_HEADING[locale]}\n\n${body}`
}

/**
 * The same snapshot, kept as the named contributions it was assembled from.
 *
 * {@link renderContextSnapshot} joins these for the model; a consumer that
 * presents the snapshot uses them to attribute each part to the subsystem that
 * contributed it, without re-splitting the joined prose.
 * @param assembly - the assembly whose contexts and variables to render.
 * @returns one entry per contributing context that rendered to non-empty text.
 */
export function renderContextSections(assembly: PromptAssembly): ContextSnapshotSection[] {
  return assembly.contexts
    .map(context => ({ name: context.name, text: interpolate(context, assembly.variables, 'context') }))
    .filter(section => section.text.length > 0)
}

/** Interpolate one section or context and attribute diagnostics to its owning input. */
function interpolate(
  input: AssembledSection | AssembledContext,
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      // A later closing brace makes this malformed; otherwise it is literal prose.
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`malformed prompt variable reference at "${text.slice(open, open + 16)}…" in ${kind} "${input.name}" (references are complete simple {{name}} groups)`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    // `{{}}` yields an empty name and follows the malformed-reference path.
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`)
    }
    // Do not resolve unregistered names through Object.prototype.
    if (!Object.hasOwn(variables, name)) {
      const known = Object.keys(variables)
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; registered variables: ${known.length > 0 ? known.join(', ') : '(none)'}`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = open + group[0].length
  }
  return result + text.slice(last)
}

/** One tool-schema provider stored in a prompt layer. */
type ToolProvider = (context: AssembleContext) => ToolProviderResult

/** One prompt-variable provider stored in a prompt layer. */
type VariableProvider = (context: AssembleContext) => string | undefined

/** All prompt registrations owned by one global or scoped layer. */
class PromptLayer implements ScopeLayer {
  readonly sections: NamedEntries<PromptSection>
  readonly contexts: NamedEntries<PromptContext>
  readonly runtimeContextSuppressors = new AnonymousEntries<true>()
  /**
   * 被本层点名抑制的分段名。具名而不是匿名：抑制的作用对象就是分段名本身，
   * 同一层里对同一个名字声明两次是重复声明，不是两个独立贡献相加——这与
   * {@link sections} 的命名规则一致，也正是抑制需要的语义。
   */
  readonly suppressedSections: NamedEntries<true>
  readonly toolProviders = new AnonymousEntries<ToolProvider>()
  /**
   * 经验追加来源。匿名而不是具名：来源不拥有分段，只是往别人的分段上贴一段话，
   * 所以两个来源共用一个名字是合法组合，让它们互斥没有意义。
   */
  readonly reflections = new AnonymousEntries<PromptReflectionSource>()
  readonly variables: NamedEntries<VariableProvider>

  /**
   * Create one prompt layer with diagnostics specific to its ownership scope.
   * @param scope - the scoped owner, or `undefined` for global registrations.
   */
  constructor(scope: ScopeKey | undefined) {
    this.sections = new NamedEntries(name => new Error(scope === undefined
      ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt section "${name}" is already registered in this scope`))
    this.contexts = new NamedEntries(name => new Error(scope === undefined
      ? `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`
      : `prompt context "${name}" is already registered in this scope`))
    this.variables = new NamedEntries(name => new Error(scope === undefined
      ? `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)`
      : `prompt variable "${name}" is already registered in this scope`))
    this.suppressedSections = new NamedEntries(name => new Error(scope === undefined
      ? `prompt section "${name}" is already suppressed (for a per-agent suppression, call \`agent.ctx.systemPrompt.suppressSection()\` instead)`
      : `prompt section "${name}" is already suppressed in this scope`))
  }

  /** @returns whether this layer owns no prompt registrations. */
  isEmpty(): boolean {
    return this.sections.isEmpty()
      && this.contexts.isEmpty()
      && this.runtimeContextSuppressors.isEmpty()
      && this.suppressedSections.isEmpty()
      && this.toolProviders.isEmpty()
      && this.reflections.isEmpty()
      && this.variables.isEmpty()
  }
}

/** Registry service for the prompt inputs assembled before each model step. */
export class SystemPrompt extends Service {
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    completePromptFile: z.string().default(undefined as unknown as string),
    autoTranslatedPrompt: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(''),
    personaSuffix: z.string().default(''),
    translatedPromptFile: z.string().min(1).default(DEFAULT_TRANSLATED_PROMPT_FILE),
    promptLocale: z.union(PROMPT_LOCALE_PREFERENCES).default('auto'),
    // Preserve omission because an explicit empty order lacks the rest marker.
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly layers = new ScopedLayers(
    scope => new PromptLayer(scope),
    () => { this.ctx.emit('system-prompt/change') },
  )
  private readonly toolOrder: string[] | undefined
  private readonly autoTranslatedPrompt: boolean
  private readonly translatedPromptFile: string
  private readonly hasCompletePromptFile: boolean
  private readonly promptLocalePreference: PromptLocalePreference
  private readonly overridesSource: { current: () => PromptOverridesSettings } = {
    current: () => DEFAULT_PROMPT_OVERRIDES,
  }
  /**
   * 界面语言的读取来源。由设置桥接注入；未注入时 `auto` 解析为 `en`，
   * 也就是"没有设置服务的部署保持内置英文文案"。
   */
  private readonly localeSource: { current: () => string | undefined } = { current: () => undefined }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'systemPrompt')
    this.toolOrder = validateToolOrder(config.toolOrder)
    let completePromptFile = config.completePromptFile
    if (completePromptFile !== undefined) {
      if (!isAbsolute(completePromptFile)) {
        throw new Error(`system-prompt: completePromptFile must be an absolute path (got "${completePromptFile}")`)
      }
      // Load-time probe: a missing file means "not configured" so deployments
      // can toggle the override by deleting the file; other failures are real.
      try {
        readFileSync(completePromptFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') completePromptFile = undefined
        else throw error
      }
    }
    if (completePromptFile !== undefined) {
      const file = completePromptFile
      this.section({
        name: 'deployment:complete-prompt',
        order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        complete: true,
        text: () => {
          try {
            return readFileSync(file, 'utf8')
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code
            throw new Error(`system-prompt: completePromptFile "${file}" became unreadable (${code ?? 'unknown'})`, { cause: error })
          }
        },
      })
    }
    // Keep harness-owned openers independent of the selected loop plugin.
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: this.getSectionOrder('HARNESS_IDENTITY'),
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: PERSONA_PREFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      // The fallback narrows the optional input type; the schema already defaults it.
      text: config.personaPrefix ?? '',
    })
    this.section({
      name: PERSONA_SUFFIX_SECTION,
      order: this.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.personaSuffix ?? '',
    })
    if (!(config.includeRuntimeContext ?? true)) this.suppressRuntimeContext()
    this.hasCompletePromptFile = completePromptFile !== undefined
    this.promptLocalePreference = config.promptLocale ?? 'auto'
    this.autoTranslatedPrompt = config.autoTranslatedPrompt ?? true
    this.translatedPromptFile = config.translatedPromptFile ?? DEFAULT_TRANSLATED_PROMPT_FILE
    // 这里不再有全局的 `mcp:intro`：介绍是按服务器来的（`mcp:<serverName>`，由
    // 挂载它的 mcp-client 实例注册）。一份"所有 MCP 共用"的介绍没有主语——没挂
    // 服务器时它照样能把提示词写满一页 MCP 用法，而那正是要避免的幻觉。
  }

  /**
   * Register an ordered prompt section in the calling context's scope. A scoped
   * section shadows a global section with the same name; duplicates within one
   * layer and non-finite orders throw. Registration and disposal emit
   * `system-prompt/change`.
   * @param section - the section to register.
   * @returns the exact Cordis effect disposer.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }

  /**
   * Resolve the centrally owned placement of a repository prompt section.
   * @param name - stable section placement name.
   * @returns the section's numeric sort order.
   */
  getSectionOrder(name: PromptSectionOrderName): number {
    return SECTION_ORDERS[name]
  }

  /**
   * List globally registered section names for prompt editing surfaces.
   *
   * This is the **global view** and deliberately excludes scoped registrations.
   * To learn "which sections an editor may change", use {@link sectionTexts},
   * which folds scopes in — the two cover different sets by design, and turning
   * this one into a union would make "what did the global layer register"
   * unanswerable.
   * @returns sorted section names visible to unscoped assemblies.
   */
  sectionNames(): string[] {
    return [...this.layers.global.sections.entries()].map(([name]) => name).sort(compareNames)
  }

  /**
   * The sections an editor may address: the global layer plus every scope's own
   * first-seen children. A named section's visibility is "the nearest same-name
   * layer wins", so when a scope already carries that name the global entry is
   * kept — a preview reads global text and does not speak for any one agent.
   * @returns insertion-ordered name→section map spanning every layer.
   */
  private editorSections(): Map<string, PromptSection> {
    const byName = new Map<string, PromptSection>(this.layers.global.sections.entries())
    for (const layer of this.layers.overlays()) {
      for (const [name, section] of layer.sections.entries()) {
        if (!byName.has(name)) byName.set(name, section)
      }
    }
    return byName
  }

  /**
   * Project the sections a Web editor may address: the global layer plus every
   * scope's own first-seen contribution, in one merged view. Static sections
   * include their current text; dynamic sections stay visible but not editable.
   *
   * Scoped sections must be listed alongside them, or the editing surface would
   * miss a whole family of capabilities: every `tool:<name>` registers in the
   * agent scope, so reading the global layer alone concludes "this deployment
   * has no tools at all". Listing them is safe — overrides apply by name to the
   * **merged** sections in the final assembly step, so scoped sections are just
   * as editable.
   * @param cwd - session workspace whose per-session prompt file supplies the
   * Chinese column; omitted reads leave that column empty.
   * @returns sorted section views for prompt editing.
   */
  async sectionTexts(cwd?: string): Promise<PromptSectionView[]> {
    const sectionContext: AssembleContext = {}
    if (cwd !== undefined) sectionContext.cwd = cwd
    const variables = { model: 'selected', cwd: cwd ?? '' }
    const sourceSections = [...this.editorSections()]
      .sort(([, a], [, b]) => comparePromptSections(a, b))
      .map(([name, section]) => {
        const editable = !NON_EDITABLE_SECTION_NAMES.has(name)
        let en = ''
        let zh = ''
        if (editable) {
          let rawEn = ''
          try {
            rawEn = typeof section.text === 'function' ? section.text(sectionContext) : section.text
          } catch {
            // A context-dependent section has no meaningful global preview.
            rawEn = ''
          }
          try {
            en = interpolate({ name, text: rawEn }, variables, 'section')
          } catch {
            en = ''
          }
          // 中文栏预填内置译文，与装配时的优先级一致：内置资产 → 项目翻译存档 →
          // 用户在编辑界面写入的覆盖。空段保持为空——"这一节现在没话说"不等于
          // "该显示默认文案"，预填会让尚未启用的能力看起来像已经启用。
          if (rawEn.trim() !== '') zh = localizedSectionText(name, rawEn, 'zh') ?? ''
        }
        // 子主题与"这一节有没有正文"无关：注册它的能力（MCP 服务器）可能这一轮
        // 一句话都没说，但它的工具照样该在编辑界面上各占一行。
        let subjects: readonly string[] = []
        try {
          subjects = [...(section.subjects?.(sectionContext) ?? [])]
        } catch {
          // A context-dependent declaration that throws simply has no sub-subjects.
          subjects = []
        }
        return { name, en, zh, editable, subjects }
      }) satisfies PromptSectionView[]
    let translated: string | undefined
    if (cwd !== undefined) translated = await this.readTranslatedPrompt({ cwd })
    if (translated !== undefined) {
      const translatedByName = mapTranslatedSections(sourceSections.map(row => ({ name: row.name, text: row.en })), translated)
      // 存档只覆盖它确实收录了的分段；缺席不等于"这一节没有中文"。
      for (const row of sourceSections) {
        const fromArchive = translatedByName.get(row.name)
        if (fromArchive !== undefined && fromArchive.trim() !== '') row.zh = fromArchive
      }
    }
    const overrides = this.overridesSource.current().sections
    for (const row of sourceSections) {
      const override = overrides[row.name]
      if (override === undefined) continue
      if (override.en.trim() !== '') row.en = override.en
      if (override.zh.trim() !== '') row.zh = override.zh
    }
    return sourceSections.sort((a, b) => compareNames(a.name, b.name))
  }

  /**
   * Install runtime-editable section replacements when the deployment mounts settings.
   * @param owner - consumer context used for section lifetime.
   * @param settings - the optional settings provider to install into.
   */
  installOverrides(
    owner: Context,
    settings: PromptOverridesSettingsInstaller,
  ): void {
    settings.installSection(
      owner,
      SYSTEM_PROMPT_OVERRIDES_SETTINGS_NAMESPACE,
      PromptOverridesSettingsSchema,
      {
        sectionCatalog: DEFAULT_SECTION_CATALOG,
        sections: {},
      },
      {
        setSource: (current) => { this.overridesSource.current = current },
        onChange: () => { /* assembly reads the source per request. */ },
      },
    )
  }

  /**
   * Adopt the source that reads the interface language.
   *
   * The registry does not know the concept of "settings" — it never injects a
   * settings service, because prompt assembly must run in deployments that have
   * none (headless, ACP, unit tests). So the language is pushed in by the
   * assembling side: the settings bridge registers "what the current interface
   * language is" at mount time, and assembly reads it once per request. One read
   * per request with no caching is what lets a language the user just changed in
   * the browser take effect on the next request instead of requiring a restart.
   *
   * @param source - reads the current interface language tag; empty means no settings service.
   */
  adoptLocaleSource(source: () => string | undefined): void {
    this.localeSource.current = source
  }

  /**
   * The prompt language in effect: an explicit config value wins, otherwise it
   * follows the interface language, and with neither it is `en`.
   * @returns `zh` or `en`.
   */
  activeLocale(): PromptLocale {
    if (this.promptLocalePreference !== 'auto') return this.promptLocalePreference
    return normalizePromptLocale(this.localeSource.current())
  }

  /**
   * Resolve the centrally owned placement of a repository runtime context.
   * @param name - stable context placement name.
   * @returns the context's numeric sort order.
   */
  getContextOrder(name: PromptContextOrderName): number {
    return CONTEXT_ORDERS[name]
  }

  /**
   * Register ordered dynamic context in the calling context's scope. Scoped
   * entries shadow global entries with the same name.
   * @param context - the context contribution to register.
   * @returns the exact Cordis effect disposer.
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }

  /**
   * Suppress every dynamic runtime-context contribution in the calling
   * context's scope without changing the services that own or enforce those
   * facts. Multiple suppressors remain independently disposable.
   * @returns the exact Cordis effect disposer.
   */
  suppressRuntimeContext(): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.runtimeContextSuppressors.append(true),
      { label: 'systemPrompt.suppressRuntimeContext()' },
    )
  }

  /**
   * Suppress one named prompt section in the calling context's scope: the name
   * disappears from every assembly that scope takes part in, no matter which
   * layer registered it — the global one, an ancestor scope, or this scope.
   *
   * This is not the same as same-name shadowing through {@link section}, and the
   * two are not substitutes: shadowing asks you to supply new body text, which
   * suits "say it my own way"; suppression states "this section does not exist
   * in this scope", which suits a single-purpose agent that wants very few
   * prompt sections. Both affect assembly only and unregister nobody's
   * registration — a suppressed section still appears in parent and sibling
   * scope assemblies.
   *
   * The reach is the whole chain: a suppression declared at any layer hides the
   * section from this scope's assemblies, and there is no inverse
   * "unsuppress" syntax. This shares its origin with
   * {@link suppressRuntimeContext} — "from this scope downward, this block does
   * not exist".
   * @param name - the section name to suppress.
   * @returns the exact Cordis effect disposer.
   */
  suppressSection(name: string): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.suppressedSections.insert(name, true),
      { label: 'systemPrompt.suppressSection()' },
    )
  }

  /**
   * Register a tool-schema provider in the calling context's scope. Global and
   * matching scoped providers both contribute; returning the reserved
   * {@link TOOL_ORDER_REST} name makes assembly fail.
   * @param provider - evaluated for each assembly with its context.
   * @returns the exact Cordis effect disposer.
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.toolProviders.append(provider),
      { label: 'systemPrompt.tools()' },
    )
  }

  /**
   * Register a per-section reflection source. Every source is consulted for
   * every section; a non-blank answer is appended below that section's own
   * text. Appending happens after user overrides and before empty optional
   * sections are dropped, and it never resurrects a section whose own text is
   * blank — an ability that is not composed in this assembly must not come back
   * just because an old lesson about it is still on disk.
   * @param source - consulted per section name on each assembly.
   * @returns the exact Cordis effect disposer.
   */
  reflectionSource(source: PromptReflectionSource): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.reflections.append(source),
      { label: 'systemPrompt.reflectionSource()' },
    )
  }

  /**
   * Register a prompt variable in the calling context's scope. Scoped values
   * shadow globals; invalid or duplicate names throw. A provider may return
   * `undefined`, but rendering a section that references that value then fails.
   * @param name - the `[a-z][a-z0-9_]*` reference name.
   * @param provider - evaluated for each assembly.
   * @returns the exact Cordis effect disposer.
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.variables.insert(name, provider),
      { label: 'systemPrompt.variable()' },
    )
  }

  /**
   * Read the per-session translated prompt when auto selection is enabled.
   * @param context - the assembly whose session workspace owns a relative path.
   * @returns the translated prompt, or undefined when no file exists.
   * @throws when the configured file exists but is empty or unreadable.
   */
  private async readTranslatedPrompt(context: AssembleContext): Promise<string | undefined> {
    const cwd = context.cwd
    if (cwd === undefined) return undefined
    const file = isAbsolute(this.translatedPromptFile)
      ? this.translatedPromptFile
      : join(cwd, this.translatedPromptFile)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return undefined
      throw new Error(`system-prompt: translatedPromptFile "${file}" is unreadable (${code ?? 'unknown'})`, { cause: error })
    }
    if (text.trim() === '') {
      throw new Error(`system-prompt: translatedPromptFile "${file}" is empty`)
    }
    return text
  }

  /**
   * Resolve the replacement for one language, or empty when the section keeps its provider text.
   * @param override - the stored per-language replacement, when one exists.
   * @param locale - 本次装配生效的语言，来自 {@link activeLocale}。
   * @returns 该语言下生效的替换文本；未提供或为空白时返回空串。
   */
  private localeOverrideText(
    override: PromptLocaleOverride | undefined,
    locale: PromptLocale,
  ): string {
    if (override === undefined) return ''
    return (locale === 'en' ? override.en : override.zh).trim()
  }

  /**
   * Replace assembled section texts with UI overrides for one language, preserving names and order.
   * @param assembly - the post-waterfall assembly to overlay.
   * @param locale - 本次装配生效的语言；显式传入而不重新解析，避免同一段文本
   * 在装配与覆盖两处各判一次语言。
   * @returns the assembly with overridden section texts.
   */
  private applyOverrides(assembly: PromptAssembly, locale: PromptLocale): PromptAssembly {
    const overrides = this.overridesSource.current().sections
    return {
      ...assembly,
      sections: assembly.sections.map((section) => {
        const text = this.localeOverrideText(overrides[section.name], locale)
        return text === '' ? section : { ...section, text }
      }),
    }
  }

  /**
   * Assemble global and scoped providers, detach tool parameters, apply
   * canonical ordering, then run the assembly waterfall. Scoped sections and
   * variables shadow globals. The returned waterfall value is authoritative
   * except that an effective complete section is restored afterwards as the
   * sole prompt section.
   * @param context - the optional scope and plugin-defined assembly fields.
   * @returns the post-waterfall assembly with any complete prompt enforced.
   */
  // Keep configuration failures on the declared asynchronous error path.
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    // 语言在这里解析一次，之后所有分段与上下文提供者都从 enriched 里读同一个值：
    // 装配内部不允许出现两处各自判断语言的地方，否则一次装配可能一半中文一半英文。
    const locale = this.activeLocale()
    const enriched: AssembleContext = context.locale === undefined ? { ...context, locale } : context
    const scope = enriched.scope
    const scopeLayers = this.layers.chainLayers(scope)
    const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
      || scopeLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
    // Scoped variables shadow globals.
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.layers.global.variables.entries()) {
      variables[name] = provider(enriched)
    }
    // Scope-chain variables, farthest first, so the nearest scope wins a name.
    for (const layer of scopeLayers) {
      for (const [name, provider] of layer.variables.entries()) {
        variables[name] = provider(enriched)
      }
    }
    // Scoped sections shadow globals before the deterministic order sort.
    const sectionByName = this.layers.merge(scope, layer => layer.sections)
    const contextByName = this.layers.merge(scope, layer => layer.contexts)
    // 抑制名单与分段一样沿链合并，所以链上任一层的声明都生效；它必须在分段
    // 定序之前生效，否则被抑制的分段会先占好位置再被抽走。
    const suppressedSections = this.layers.merge(scope, layer => layer.suppressedSections)
    // Validate order against pre-restriction names while collecting visible schemas.
    const providers = [
      ...this.layers.global.toolProviders.values(),
      ...scopeLayers.flatMap(layer => [...layer.toolProviders.values()]),
    ]
    const collected: ToolSchema[] = []
    const knownNames = new Set<string>()
    for (const provider of providers) {
      const result = provider(enriched)
      const schemas = result.schemas.map(({ name, description, parameters }): ToolSchema => ({
        name,
        description,
        parameters: structuredClone(parameters),
      }))
      const acceptedKnownNames = result.knownNames ?? schemas.map(tool => tool.name)
      collected.push(...schemas)
      for (const name of acceptedKnownNames) knownNames.add(name)
    }
    let sectionDefinitions = [...sectionByName.values()]
      .filter(section => !suppressedSections.has(section.name))
      .sort(comparePromptSections)
    // 内置双语资产先按语言替换第一方分段，随后才轮到项目翻译存档与用户覆盖——
    // 顺序就是优先级，越靠后越能盖住前面的。
    sectionDefinitions = sectionDefinitions.map(section => localizeSection(section, locale))
    if (
      this.autoTranslatedPrompt
      && locale === 'zh'
      && !this.hasCompletePromptFile
      && !sectionDefinitions.some(section => section.complete === true)
    ) {
      const translated = await this.readTranslatedPrompt(enriched)
      if (translated !== undefined) {
        const preWaterfallSections: Array<{ name: string; text: string; complete?: boolean }> = sectionDefinitions
          .map(section => ({
            name: section.name,
            text: typeof section.text === 'function' ? section.text(context) : section.text,
            ...(section.complete === true ? { complete: true } : {}),
          }))
        const translations = mapTranslatedSections(preWaterfallSections, translated)
        sectionDefinitions = sectionDefinitions.flatMap((section) => {
          const text = translations.get(section.name)
          if (text === undefined) return [section]
          return [{ ...section, text }]
        })
      }
    }
    const completeSections = sectionDefinitions.filter(section => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(section => JSON.stringify(section.name)).join(', ')}`)
    }
    let completeSection: AssembledSection | undefined
    const sections = sectionDefinitions
      .map((section) => {
        const assembled = {
          name: section.name,
          text: typeof section.text === 'function' ? section.text(enriched) : section.text,
          ...section.interpolate !== undefined ? { interpolate: section.interpolate } : {},
        }
        if (section.complete === true) completeSection = { ...assembled }
        return assembled
      })
    const assembly: PromptAssembly = {
      sections,
      contexts: runtimeContextSuppressed
        ? []
        : [...contextByName.values()]
          .sort((a, b) => a.order - b.order)
          .map(entry => ({
            name: entry.name,
            text: typeof entry.text === 'function' ? entry.text(enriched) : entry.text,
          })),
      tools: orderTools(collected, this.toolOrder, knownNames),
      variables,
      locale,
    }
    const transformed = await this.ctx.waterfall(
      scopeTarget(this, scope), 'system-prompt/assemble', assembly, enriched,
      () => Promise.resolve(assembly),
    )
    const overridden = completeSection === undefined ? this.applyOverrides(transformed, locale) : transformed
    // 反思追加排在覆盖之后：用户覆盖的是"介绍"，反思是独立的一层，两者互不吞掉。
    const reflected = completeSection === undefined
      ? applyReflections(overridden, [
        ...this.layers.global.reflections.values(),
        ...scopeLayers.flatMap(layer => [...layer.reflections.values()]),
      ])
      : overridden
    // 可选分段的判空必须排在覆盖与反思之后：`mcp:<server>` 与 `computer:policy`
    // 靠"这一节有没有话要说"决定去留，先过滤会把刚写好的内容静默丢掉。
    const visible = completeSection === undefined ? dropEmptyOptionalSections(reflected) : reflected
    if (completeSection === undefined && !runtimeContextSuppressed) return visible
    return {
      ...visible,
      sections: completeSection === undefined ? visible.sections : [completeSection],
      contexts: runtimeContextSuppressed ? [] : visible.contexts,
    }
  }
}

export default SystemPrompt
