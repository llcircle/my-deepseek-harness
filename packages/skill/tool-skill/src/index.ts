/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { PromptLocale } from '@deepseek-ai/dsh-system-prompt'
import '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { readSkillTranslations, skillTranslationFiles } from '@deepseek-ai/dsh-skill/translations'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills', 'systemPrompt']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/** Locales with catalog translation support; anything else renders the raw catalog. */
const CATALOG_LOCALES = ['auto', 'en', 'zh'] as const
export type CatalogLocale = (typeof CATALOG_LOCALES)[number]
/** Default per-project translation archive consumed by the Chinese catalog. */
const DEFAULT_CATALOG_TRANSLATIONS_FILE = '.dsh/skill-translations.zh.json'
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/**
 * 决定本次目录是否用中文。
 *
 * 抽成纯函数是因为它是"配置 + 装配语言 + 归档是否存在"三者的一次判定，
 * 而它原本埋在装配监听器里、拿不到也断言不了。判定顺序即优先级：
 * 显式配置 > 本次装配的语言（界面语言设置）> 归档启发式。
 *
 * @param configured - 插件配置的语言。
 * @param assemblyLocale - 本次装配解析出的语言；离线渲染时可能没有。
 * @param hasTranslations - 项目是否存在可用的简介译文归档。
 * @returns 是否以中文渲染目录框架与简介。
 */
export function catalogUsesChinese(
  configured: CatalogLocale,
  assemblyLocale: PromptLocale | undefined,
  hasTranslations: boolean,
): boolean {
  if (configured === 'zh') return true
  if (configured === 'en') return false
  if (assemblyLocale !== undefined) return assemblyLocale === 'zh'
  // 没有装配语言（离线渲染、手工构造）时才退回"项目里有译文就用中文"的启发式。
  return hasTranslations
}

/** Durable entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
  translations?: ReadonlyMap<string, string>,
): SkillCatalogSource['entries'] {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(
      translations?.get(skill.name) ?? skill.description,
      descriptionMaxLength,
    ),
  }))
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /**
   * Locale for the session catalog (default `auto`). `auto` follows the
   * language the assembly resolved — which, unless a deployment pins
   * `system-prompt.promptLocale`, is the interface language the user picked in
   * settings — and falls back to the archive heuristic (Chinese when the
   * per-project translation archive carries at least one description) for
   * assemblies that carry no locale. `zh` selects Chinese unconditionally;
   * `en` never translates.
   */
  catalogLocale?: CatalogLocale
  /**
   * Translation archive the `zh` locale reads; relative paths resolve against
   * the session workspace (default `.dsh/skill-translations.zh.json`, the
   * `/translate-skills` archive).
   */
  catalogTranslationsFile?: string
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  catalogLocale: z.union(CATALOG_LOCALES).default('auto'),
  catalogTranslationsFile: z.string().default(DEFAULT_CATALOG_TRANSLATIONS_FILE),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * durable session catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const catalogLocale = config.catalogLocale ?? 'auto'
  const catalogTranslationsFile = config.catalogTranslationsFile ?? DEFAULT_CATALOG_TRANSLATIONS_FILE

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)

  // User-explicit skill invocation: a claimed user message whose first line
  // starts with `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog and the `skill` tool below never see them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: agent.session.header.cwd, signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })

  // The catalog belongs to the system prompt, not to the first user-message batch.
  // Register an empty ordered section now; the assembly listener fills its text after
  // resolving the current agent's scoped skills and project translation archive.
  // `interpolate: false` is load-bearing: skill descriptions are data written by
  // whoever authored the skill, and a description containing `{{name}}` must not be
  // read as a prompt variable — that would fail the whole assembly, not just this
  // section, the moment any skill mentions a template placeholder.
  ctx.systemPrompt.section({
    name: 'skills:catalog',
    order: ctx.systemPrompt.getSectionOrder('SKILL_CATALOG'),
    text: '',
    interpolate: false,
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const transformed = await next()
    const agent = context.agent
    if (agent === undefined) return transformed
    const toolVisible = ctx.tools.get(skillTool.name, agent) === skillTool
    const snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal: context.signal, scope: agent })
      : { skills: [], complete: true }
    context.signal?.throwIfAborted()
    if (!snapshot.complete) return transformed
    const skills = snapshot.skills.filter(isModelInvocable)
    const translations = catalogLocale !== 'en' && agent.session.header.cwd !== undefined
      ? await loadCatalogTranslations(agent.session.header.cwd, catalogTranslationsFile)
      : new Map<string, string>()
    const catalogInChinese = catalogUsesChinese(catalogLocale, context.locale, translations.size > 0)
    const entries = catalogSourceEntries(
      skills,
      catalogDescriptionMaxLength,
      catalogInChinese ? translations : undefined,
    )
    const text = entries.length === 0 ? '' : renderCatalogText(entries, catalogInChinese)
    return {
      ...transformed,
      sections: transformed.sections.map(section => section.name === 'skills:catalog'
        ? { ...section, text }
        : section),
    }
  })
}

/**
 * Candidate translation archives in precedence order: the workspace archive
 * first, then the harness-home archive of the same file name.
 *
 * The workspace archive alone cannot cover the common case: skills live in a
 * shared (user-level) registry, so a catalog translated once for one project
 * reads as untranslated in every other one. Falling back to the harness home
 * makes a single translation pass cover every workspace, while a workspace
 * entry still wins so a project can pin its own wording.
 *
 * Thin alias over the shared resolver — see
 * `@deepseek-ai/dsh-skill/translations` for the rule itself.
 *
 * @param cwd - the session workspace a relative configured path resolves against.
 * @param configured - the configured archive path, relative or absolute.
 * @param home - the resolved harness home; injectable so the layering stays testable.
 * @returns the archives to merge, highest precedence first.
 */
export function catalogTranslationFiles(
  cwd: string,
  configured: string,
  home: string = resolveDshHome(),
): string[] {
  return skillTranslationFiles(cwd, configured, home)
}

/**
 * Load the layered translation archives into one name→description map. The
 * layering, the per-field merge, and the degrade-to-untranslated rules live in
 * `@deepseek-ai/dsh-skill/translations`: the slash-menu catalog reads the very
 * same archives, and two copies of the precedence rule is exactly how one
 * surface keeps rendering English after the other was fixed.
 * @param cwd - the session workspace a relative configured path resolves against.
 * @param configured - the configured archive path, relative or absolute.
 * @param home - the resolved harness home; injectable so the layering stays testable.
 * @returns the merged translations, empty when no archive exists.
 */
export async function loadCatalogTranslations(
  cwd: string,
  configured: string,
  home: string = resolveDshHome(),
): Promise<Map<string, string>> {
  const descriptions = new Map<string, string>()
  for (const [name, translation] of await readSkillTranslations(cwd, configured, home)) {
    if (translation.description !== undefined) descriptions.set(name, translation.description)
  }
  return descriptions
}

function renderCatalogText(
  entries: SkillCatalogSource['entries'],
  inChinese: boolean,
): string {
  const framing = inChinese
    ? [
      '技能是一组可复用的任务专用指令。以下技能在当前会话中可用：',
      '',
      '<available_skills>',
      ...renderCatalogEntries(entries),
      '</available_skills>',
      '',
      '如果用户指名某个技能，或任务明显匹配某个技能的描述，请先使用 `skill` 工具加载该技能的精确名称，再执行任务动作。加载所有适用技能，然后遵循其完整指令。此目录只包含摘要；在加载之前，不要推断或遵循技能的指令。',
      '用户也可以直接调用技能；其 <skill_content> 块随后会出现在本对话中。请遵循该块，并且不要再次为该技能调用 `skill` 工具。',
    ]
    : [
      'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
      '',
      '<available_skills>',
      ...renderCatalogEntries(entries),
      '</available_skills>',
      '',
      "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return ['<system-reminder>', ...framing, '</system-reminder>'].join('\n')
}

/**
 * Model-facing catalog lines, projected from the same entries the source records.
 * The pseudo-XML escaping belongs to this frame, not to the published fact, so it
 * is applied here and never stored. Names are `isSkillName`-validated and carry
 * no escapable character.
 */
function renderCatalogEntries(entries: SkillCatalogSource['entries']): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

function catalogDescription(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
