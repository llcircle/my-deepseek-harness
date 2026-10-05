/**
 * Model-facing `skill` loader tool plus the retrieval list that names the
 * skills relevant to the turn.
 *
 * ## Why the list is a message and not a prompt section
 *
 * The catalog used to be a system-prompt section: every skill's name and
 * description sat in the *head* of every request, ahead of all history. Two
 * things are wrong with that once a session can WRITE skills.
 *
 * The first is cost. The head is the stable cache prefix, so any change to the
 * catalog — a skill added, a description reworded, a `.system` entry the user
 * disabled — rewrote the prefix and re-charged the whole conversation for it.
 * A catalog that the agent itself maintains changes exactly when the work
 * happens, which is the worst possible moment.
 *
 * The second is attention. A hundred skills listed every turn is a hundred
 * lines of furniture the model must read past before reaching the request. Most
 * of them are irrelevant to what was just asked.
 *
 * So the list is now *retrieved*: at the first step of each turn the claimed
 * user text is scored against every skill's name and description with BM25
 * ({@link rankSkillSummaries}), and the winners are appended to the step's
 * messages as one more user-role message. The prefix is untouched — the message
 * is an append — and the model reads a short, relevant list.
 *
 * ## Why retrieval can be trusted to be total
 *
 * A short list is only safe because the loader is not limited by it. The `skill`
 * tool takes an exact name and knows every skill the registry holds, so a
 * retrieval miss costs one guess by name rather than losing the skill; the
 * rendered list says so out loud. That is what makes it acceptable to name five
 * skills instead of a hundred.
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
  rankSkillSummaries,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'
import { readSkillTranslations, skillTranslationFiles } from '@deepseek-ai/dsh-skill/translations'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills', 'systemPrompt']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
/**
 * How many skills one turn's retrieval list may name.
 *
 * Five is the width the on-demand tool index settled on for the same reason:
 * a list is read as "these are the candidates", and a list long enough to
 * contain the answer whatever the question is has stopped being a selection.
 * A deployment with a deliberately small catalog can raise it; the cap exists
 * so an unattended corpus cannot refill the prompt.
 */
const DEFAULT_RETRIEVAL_MAX_RESULTS = 5
/** Locales with catalog translation support; anything else renders the raw catalog. */
const CATALOG_LOCALES = ['auto', 'en', 'zh'] as const
/**
 * Locale the published skill list renders in. `auto` follows the active prompt
 * language so a Chinese deployment gets a Chinese list, while `en` and `zh` pin
 * it regardless of the surrounding language.
 */
export type CatalogLocale = (typeof CATALOG_LOCALES)[number]
/** Default per-project translation archive consumed by the Chinese list. */
const DEFAULT_CATALOG_TRANSLATIONS_FILE = '.dsh/skill-translations.zh.json'
/**
 * Durable entry list mirroring a rendered skill catalog.
 *
 * The catalog is no longer a prompt section, so nothing publishes this message
 * today. The shape stays declared because it is a committed durable format:
 * sessions already on disk carry `skill-catalog` sources, and readers must keep
 * resolving them (`docs/persistence-schema.json` is generated from here).
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
 * 决定本次清单是否用中文。
 *
 * 抽成纯函数是因为它是"配置 + 当前语言 + 归档是否存在"三者的一次判定，
 * 而它原本埋在装配监听器里、拿不到也断言不了。判定顺序即优先级：
 * 显式配置 > 当前提示词语言（界面语言设置）> 归档启发式。
 *
 * @param configured - 插件配置的语言。
 * @param assemblyLocale - 当前生效的提示词语言；离线渲染时可能没有。
 * @param hasTranslations - 项目是否存在可用的简介译文归档。
 * @returns 是否以中文渲染清单框架与简介。
 */
export function catalogUsesChinese(
  configured: CatalogLocale,
  assemblyLocale: PromptLocale | undefined,
  hasTranslations: boolean,
): boolean {
  if (configured === 'zh') return true
  if (configured === 'en') return false
  if (assemblyLocale !== undefined) return assemblyLocale === 'zh'
  // 没有提示词语言（离线渲染、手工构造）时才退回"项目里有译文就用中文"的启发式。
  return hasTranslations
}

/** Durable description list mirroring the rendered list lines. */
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

/** Model-facing skill list configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the retrieval list; minimum 3. */
  catalogDescriptionMaxLength?: number
  /**
   * Locale for the retrieval list (default `auto`). `auto` follows the active
   * prompt language — which, unless a deployment pins
   * `system-prompt.promptLocale`, is the interface language the user picked in
   * settings — and falls back to the archive heuristic (Chinese when the
   * per-project translation archive carries at least one description) when no
   * language is active. `zh` selects Chinese unconditionally; `en` never
   * translates.
   */
  catalogLocale?: CatalogLocale
  /**
   * Translation archive the `zh` locale reads; relative paths resolve against
   * the session workspace (default `.dsh/skill-translations.zh.json`, the
   * `/translate-skills` archive).
   */
  catalogTranslationsFile?: string
  /**
   * How many skills one turn's retrieval list may name (default 5, minimum 1).
   * The list is a selection, not a catalog: see `DEFAULT_RETRIEVAL_MAX_RESULTS`.
   */
  retrievalMaxResults?: number
}

/** Validate and default the model-facing skill list configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  catalogLocale: z.union(CATALOG_LOCALES).default('auto'),
  catalogTranslationsFile: z.string().default(DEFAULT_CATALOG_TRANSLATIONS_FILE),
  retrievalMaxResults: z.number().default(DEFAULT_RETRIEVAL_MAX_RESULTS),
})

/**
 * Register the model-facing skill loader and the per-turn retrieval list that
 * names the skills worth loading. Both are bound to the same tool
 * registration: a restriction or scoped same-name shadow removes the schema,
 * and the list then has nothing to point at, so it disappears with it.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const catalogLocale = config.catalogLocale ?? 'auto'
  const catalogTranslationsFile = config.catalogTranslationsFile ?? DEFAULT_CATALOG_TRANSLATIONS_FILE
  const retrievalMaxResults = config.retrievalMaxResults ?? DEFAULT_RETRIEVAL_MAX_RESULTS
  assertPositiveInteger('retrievalMaxResults', retrievalMaxResults, 1)

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for a skill. The harness injects a list of skills relevant to the current request; call this with the exact skill name from that list before acting on a task that names or clearly matches that skill. Any skill name the registry holds works here, including one the list did not mention.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name, as written in the injected skill list.' },
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
  // first (workspace rules, runtime policy, the retrieval list), the material
  // the model must act on last, closest to its answer. Registration order
  // makes that placement deterministic: this listener registers before the
  // retrieval listener, so the waterfall hands it the retrieval-bearing list
  // to extend. Only `source.kind === 'user'` messages are scanned — external
  // text cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // retrieval list and the `skill` tool below never see them.
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

  // The retrieval list rides the STEP, not the system prompt. See the module
  // header for why; the short version is that the list changes exactly when the
  // work happens, and the system prompt is the one place a change is expensive.
  ctx.on('agent/pre-step', async (
    { agent, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    // One list per turn, injected on its first step. Every step would append a
    // fresh copy, so a turn that made twenty tool calls would carry twenty
    // identical lists; the first one stays in context for the rest of the turn
    // either way.
    if (step !== 1) return decision
    // An empty batch means no model call happens for this step. Injecting into
    // it would conjure a turn out of a list nobody asked for.
    if (decision.messages.length === 0) return decision
    const query = rankingQuery(decision.messages)
    if (query === '') return decision
    // The list points at the loader, so it lives and dies with it: a
    // composition that restricts or shadows the tool must not keep advertising
    // skills the model cannot open.
    if (ctx.tools.get(skillTool.name, agent) !== skillTool) return decision
    const snapshot = await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
    signal.throwIfAborted()
    // An incomplete catalog is not a catalog: rendering a partial list would
    // present "the skills that happen to be discoverable right now" as the
    // answer, which is worse than saying nothing.
    if (!snapshot.complete) return decision
    const skills = snapshot.skills.filter(isModelInvocable)
    if (skills.length === 0) return decision
    const ranked = rankSkillSummaries(skills, query, retrievalMaxResults)
    const translations = catalogLocale !== 'en' && agent.session.header.cwd !== undefined
      ? await loadCatalogTranslations(agent.session.header.cwd, catalogTranslationsFile)
      : new Map<string, string>()
    signal.throwIfAborted()
    const inChinese = catalogUsesChinese(catalogLocale, ctx.systemPrompt.activeLocale(), translations.size > 0)
    const text = renderRetrievalText(
      catalogSourceEntries(ranked, catalogDescriptionMaxLength, inChinese ? translations : undefined),
      inChinese,
      skills.length,
    )
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-tool-skill', form: 'catalog' },
      })],
    }
  })
}

/**
 * Candidate translation archives in precedence order: the workspace archive
 * first, then the harness-home archive of the same file name.
 *
 * The workspace archive alone cannot cover the common case: skills live in a
 * shared (user-level) registry, so a list translated once for one project reads
 * as untranslated in every other one. Falling back to the harness home makes a
 * single translation pass cover every workspace, while a workspace entry still
 * wins so a project can pin its own wording.
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

/**
 * Render the retrieval list: a header naming the selection and its size, the
 * `<available_skills>` block, and the instructions that make the list safe.
 *
 * Two sentences carry the weight. "This list contains summaries only" is what
 * stops the model inferring a skill's behaviour from a one-line description.
 * "The list is a selection" is what stops a retrieval miss being read as "no
 * such skill" — and {@link Config.retrievalMaxResults} means there is always a
 * miss whenever the catalog is wider than the cap, so the model has to know the
 * loader accepts names the list never mentioned.
 *
 * @param entries - the ranked entries to name.
 * @param inChinese - render the framing in Chinese.
 * @param total - how many skills the session holds in total.
 * @returns the complete model-facing `<system-reminder>` block.
 */
function renderRetrievalText(
  entries: SkillCatalogSource['entries'],
  inChinese: boolean,
  total: number,
): string {
  const framing = inChinese
    ? [
      `技能是一组可复用的任务专用指令。下面是与当前请求最相关的技能（本会话共 ${total} 个可用技能，此处只列出其中 ${entries.length} 个）。此清单取代更早的技能清单：`,
      '',
      '<available_skills>',
      ...renderCatalogEntries(entries),
      '</available_skills>',
      '',
      '如果用户指名某个技能，或任务明显匹配某个技能的描述，请先使用 `skill` 工具加载该技能的精确名称，再执行任务动作。加载所有适用技能，然后遵循其完整指令。此清单只包含摘要；在加载之前，不要推断或遵循技能的指令。清单是挑出来的，不是全部——这里没列出的技能同样可以用精确名称加载。',
      '用户也可以直接调用技能；其 <skill_content> 块随后会出现在本对话中。请遵循该块，并且不要再次为该技能调用 `skill` 工具。',
    ]
    : [
      `A skill is a reusable set of task-specific instructions. These are the skills most relevant to the current request (this session holds ${total} in total; ${entries.length} listed here). This list supersedes any earlier skill list:`,
      '',
      '<available_skills>',
      ...renderCatalogEntries(entries),
      '</available_skills>',
      '',
      "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This list contains summaries only; do not infer or follow a skill's instructions until it has been loaded. The list is a selection, not the whole catalog — a skill it does not mention can still be loaded by name.",
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return ['<system-reminder>', ...framing, '</system-reminder>'].join('\n')
}

/**
 * Model-facing list lines, projected from the same entries the durable source
 * records. The pseudo-XML escaping belongs to this frame, not to the published
 * fact, so it is applied here and never stored. Names are `isSkillName`-validated
 * and carry no escapable character.
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
 * The text one step is ranked against: exactly what the human wrote.
 *
 * Only direct user input participates. Tool results, injected context, and
 * another agent's relay would all rank the skills against text nobody asked
 * for — and the injected runtime-context snapshot in particular quotes long
 * policy prose that would swamp the request.
 *
 * @param messages - the step's claimed batch.
 * @returns the joined direct-user text, or `''` when the step carries none.
 */
function rankingQuery(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n')
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
