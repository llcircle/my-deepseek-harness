/**
 * Learning from a session's own work: the `/summarize-skill` command and the
 * curation passes that run at a compaction boundary. Every child is a background
 * one-shot subagent; none runs model work on the session's own turn, and a
 * child's files land in a skill root the filesystem provider already watches, so
 * a skill written here is discoverable on the next lookup with no manual
 * invalidation.
 *
 * ## Two triggers, one job
 *
 * `/summarize-skill` is the explicit form: the human points at a stretch of the
 * conversation and asks for a skill, optionally saying what to capture.
 *
 * The automatic form needs no gesture. Compaction has just produced a summary of
 * the work this session did — that summary IS the experience worth keeping.
 *
 * ## Two children, because the two judgments need different evidence
 *
 * A compaction boundary can ask two unrelated questions, and they are asked
 * separately so that each child gets its own prompt, its own evidence, and its
 * own permission:
 *
 * - {@link buildCreationPrompt} — CREATION. "Did this work establish a procedure
 *   the corpus does not cover?" The evidence is the summary plus the corpus as a
 *   listing. The child may write exactly ONE new file and may not touch an
 *   existing one. It runs at every successful boundary, because the summary is
 *   always evidence about what the corpus lacks.
 * - {@link buildReflectionPrompt} — REFLECTION. "Was a skill this session
 *   actually loaded wrong?" The evidence is the summary plus those skills
 *   printed IN FULL. The child may rewrite the files it was handed and may not
 *   create anything. It runs ONLY when the stretch loaded at least one skill
 *   that this deployment OWNS (see {@link loadedSkillNames} and
 *   {@link selectReflectionTargets}): a skill nobody opened was never
 *   exercised, so there is nothing to correct it against, and asking anyway
 *   would invite edits to text the summary never touched. A loaded skill that
 *   is not ours fails the same test for the same reason — it was exercised, but
 *   rewriting it would be editing another program's files.
 *
 * Both are why the corpus is narrowed to the roots this deployment can attribute
 * to itself (see {@link CURATABLE_SOURCES}) — a machine-wide
 * `<agentsHome>/skills` belongs to whatever else follows that convention, and
 * rewriting it would be editing another program's files.
 *
 * ## Why reflection runs first, and why creation re-reads the corpus
 *
 * Reflection corrects what was used; creation then adds only what is still
 * missing. Running them in that order means the creation child is handed a
 * listing taken AFTER any rewrite, so the procedure reflection just sharpened is
 * visible to it as already covered rather than looking absent. The second
 * listing is taken only when a reflection child actually ran — it is the only
 * thing that can have changed the corpus.
 *
 * ## Why compaction is the only moment, and why that keeps the cache stable
 *
 * The curation child is a SEPARATE session. It never appends to the parent's
 * history and never touches the parent's assembled system prompt, so the
 * parent's stable cache prefix is untouched whether the child writes one skill
 * or ten. What a session cannot change for free is a system-prompt SECTION —
 * and skills no longer live in one: the model-facing list is retrieved per turn
 * and appended to the step's own messages (see `@deepseek-ai/dsh-tool-skill`).
 *
 * Compaction is therefore only the TRIGGER, chosen because it is the moment the
 * session itself declares "this stretch of work is over and has been
 * summarised": no extra prompt section, no extra turn, and the one boundary at
 * which the parent was going to rebuild its prefix anyway.
 *
 * @module @deepseek-ai/dsh-command-summarize-skill
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { ContentBlock, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the `compaction/summary` / `compaction/end` event declarations this file gates on.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { loadedSkillName, type SkillSummary } from '@deepseek-ai/dsh-skill'
// Type-only: pulls the ctx.commands, ctx.subagents, ctx.agents, and ctx.skills service merges.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'command-summarize-skill'

/** Plugin configuration. */
export interface Config {
  /** Skill root the child writes into; relative to the child's workspace. */
  skillsDir?: string
  /** Optional cap on user/assistant text turns handed to the child; omit for the full conversation. */
  maxTurns?: number
  /** Subagent provider that runs the summarization child. */
  provider?: string
  /**
   * Tools the summarization child keeps; every other inherited tool is removed.
   * Defaults to reading and writing — see {@link DEFAULT_CHILD_TOOLS}.
   */
  childTools?: string[]
  /**
   * Prompt sections the summarization child does not get; defaults to deployment
   * identity, persona, and the error-lessons section. An empty list suppresses
   * nothing.
   */
  childOmitSections?: string[]
  /**
   * Whether a successful compaction also curates the corpus (default `true`).
   * Off, only the explicit command captures anything — no creation child and no
   * reflection child.
   */
  autoCurate?: boolean
  /**
   * How many loaded skills the reflection child receives IN FULL for rewriting
   * (default 3). The most recently loaded ones win, and an overflow line names
   * how many older ones were left out, so the child knows it is looking at a
   * subset rather than at everything the stretch touched.
   */
  curateMaxTargets?: number
  /**
   * How many owned skills the creation child is told about (default 30). The
   * listing is the duplicate guard: a skill whose content restates one that
   * already exists is worse than no new skill.
   */
  curateMaxListedSkills?: number
}

/**
 * Tools the summarization child keeps.
 *
 * 会话记录已经在提示词里给全了，子 agent 要做的是把它压缩成一份技能文档并写进
 * 技能目录。`write` 是必需的那一个；保留 `read` 让它能核对已存在的技能文件，
 * 避免把同名技能覆盖成与既有内容矛盾的样子。
 */
const DEFAULT_CHILD_TOOLS = ['read', 'write']

/**
 * Prompt sections the summarization child does not get.
 *
 * 写技能文档不需要部署身份、人格（那是给编码 agent 的措辞）或工具失败反思——
 * 后两者只会把提示词撑长，而子 agent 的判断依据应当只有它收到的那段材料。
 */
const DEFAULT_CHILD_OMIT_SECTIONS = ['harness:identity', 'deployment:persona-prefix', 'deployment:error-lessons']

const DEFAULT_AUTO_CURATE = true
const DEFAULT_CURATE_MAX_TARGETS = 3
const DEFAULT_CURATE_MAX_LISTED_SKILLS = 30
/** Character cap on one listed description; the full text is in the file. */
const LISTED_DESCRIPTION_MAX = 200

/**
 * Skill sources this deployment owns, and may therefore rewrite.
 *
 * 这两个根由本部署自己创建和维护 —— 项目里的是 `<project>/.dsh/skills`，机器级的
 * 是 `<dshHome>/skills`。别的来源都不在名单里：`bundled` 是随包发布的只读内容，
 * `custom` 由部署显式配置、归配置者所有，`runtime` 根本没有文件，而
 * `project-agents` / `user-agents` 用的是别的工具也在用的通用约定。让模型改写
 * 那些目录，等于替别人的程序动文件。
 */
const CURATABLE_SOURCES: ReadonlySet<string> = new Set(['project-dsh', 'user-dsh'])

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  skillsDir: z.string().min(1).default('.dsh/skills'),
  maxTurns: z.number().step(1).min(1),
  provider: z.string().min(1).default('spawn'),
  childTools: z.array(z.string()).default([...DEFAULT_CHILD_TOOLS]),
  childOmitSections: z.array(z.string()).default([...DEFAULT_CHILD_OMIT_SECTIONS]),
  autoCurate: z.boolean().default(DEFAULT_AUTO_CURATE),
  curateMaxTargets: z.number().step(1).min(1).default(DEFAULT_CURATE_MAX_TARGETS),
  curateMaxListedSkills: z.number().step(1).min(1).default(DEFAULT_CURATE_MAX_LISTED_SKILLS),
})

/** Configuration resolved once at load, with every default applied and validated. */
export interface ResolvedConfig {
  /** Skill root new skills are written under; relative to the child's workspace. */
  skillsDir: string
  /** Optional cap on turns handed to the explicit command's child. */
  maxTurns: number | undefined
  /** Subagent provider that runs either child. */
  provider: string
  /** Tools both children keep. */
  childTools: readonly string[]
  /** Prompt sections neither child gets. */
  childOmitSections: readonly string[]
  /** Whether the compaction pass is armed. */
  autoCurate: boolean
  /** How many existing skills a curation child receives in full. */
  curateMaxTargets: number
  /** How many owned skills a curation child is told about. */
  curateMaxListedSkills: number
}

/**
 * Resolve and validate configuration; misconfiguration fails at load.
 * @param config - plugin configuration; every field is optional.
 * @returns the skills directory, the optional turn cap, the provider, the two
 * curation widths, whether the automatic pass is armed, and the child
 * composition both triggers propagate.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const maxTurns = config.maxTurns
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw new Error('command-summarize-skill: maxTurns must be a positive integer')
  }
  const curateMaxTargets = config.curateMaxTargets ?? DEFAULT_CURATE_MAX_TARGETS
  if (!Number.isInteger(curateMaxTargets) || curateMaxTargets < 1) {
    throw new Error('command-summarize-skill: curateMaxTargets must be a positive integer')
  }
  const curateMaxListedSkills = config.curateMaxListedSkills ?? DEFAULT_CURATE_MAX_LISTED_SKILLS
  if (!Number.isInteger(curateMaxListedSkills) || curateMaxListedSkills < 1) {
    throw new Error('command-summarize-skill: curateMaxListedSkills must be a positive integer')
  }
  return {
    skillsDir: config.skillsDir ?? '.dsh/skills',
    maxTurns,
    provider: config.provider ?? 'spawn',
    childTools: config.childTools ?? DEFAULT_CHILD_TOOLS,
    childOmitSections: config.childOmitSections ?? DEFAULT_CHILD_OMIT_SECTIONS,
    autoCurate: config.autoCurate ?? DEFAULT_AUTO_CURATE,
    curateMaxTargets,
    curateMaxListedSkills,
  }
}

/** One conversation turn as the summarizer sees it. */
export interface ConversationTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Parsed command input: optional turn selection plus free-text guidance. */
export interface SummaryInput {
  /** Keep only the newest `last` turns. */
  last?: number
  /** 1-based inclusive `[from, to]` range over the full conversation; both set together. */
  from?: number
  to?: number
  /** User guidance for what to capture; the child follows it over the generic rule. */
  guidance?: string
}

/**
 * Parse the raw command text: a leading `N` keeps the newest N turns, a
 * leading `N-M` selects that 1-based inclusive range, and everything else —
 * or the text after either selector — is user guidance. A bare string without
 * a leading selector is guidance for the whole conversation.
 * @param rawInput - raw text typed after the `/summarize-skill` command name.
 * @returns the parsed turn selection and/or guidance; `{}` for blank input.
 */
export function parseSummaryInput(rawInput: string): SummaryInput {
  const trimmed = rawInput.trim()
  if (trimmed === '') return {}
  const range = /^(\d+)\s*-\s*(\d+)(?![\p{L}\p{N}_-])/u.exec(trimmed)
  if (range !== null) {
    const from = Number(range[1])
    const to = Number(range[2])
    if (from < 1) throw new Error(`summarize-skill: range start must be >= 1 (got ${from})`)
    if (to < from) throw new Error(`summarize-skill: range end ${to} must be >= start ${from}`)
    const guidance = trimmed.slice(range[0].length).trim()
    return guidance === '' ? { from, to } : { from, to, guidance }
  }
  const last = /^(\d+)(?![\p{L}\p{N}_-])/u.exec(trimmed)
  if (last !== null) {
    const count = Number(last[1])
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`summarize-skill: turn count must be >= 1 (got ${String(count)})`)
    }
    const guidance = trimmed.slice(last[0].length).trim()
    return guidance === '' ? { last: count } : { last: count, guidance }
  }
  return { guidance: trimmed }
}

/**
 * Apply the parsed selection to the full conversation.
 * @param turns - the whole conversation, oldest first.
 * @param input - parsed selection from {@link parseSummaryInput}.
 * @returns the selected turns, oldest first.
 */
export function selectTurns(turns: readonly ConversationTurn[], input: SummaryInput): ConversationTurn[] {
  if (input.from !== undefined && input.to !== undefined) {
    if (input.from > turns.length) {
      throw new Error(`summarize-skill: range start ${input.from} exceeds the ${turns.length} conversation turns`)
    }
    return turns.slice(input.from - 1, input.to)
  }
  if (input.last !== undefined) return turns.slice(-input.last)
  return [...turns]
}

/**
 * Extract the user/assistant text turns from committed session events. An
 * undefined `max` keeps the whole conversation; otherwise only the newest
 * `max` turns are kept.
 * @param events - committed session events in log order.
 * @param max - keep only the newest N turns; omit to keep the whole conversation.
 * @returns the user/assistant text turns, oldest first.
 */
export function recentTurns(events: readonly SessionEvent[], max?: number): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const text = textOf(event.data.content)
      if (text !== '') turns.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      if (event.data.interrupted === true) continue
      const text = textOf(event.data.message.content)
      if (text !== '') turns.push({ role: 'assistant', text })
    }
  }
  return max === undefined ? turns : turns.slice(-max)
}

/** Join the text blocks of one content list, dropping tool and other non-text blocks. */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
}

/**
 * The text one `tool/result` payload carries.
 *
 * A tool-result message nests its payload one level down: the `tool-result`
 * block holds the content the tool actually produced. {@link textOf} — the flat
 * reader used for conversation turns — would therefore see nothing here, which
 * would make every model-visible skill load invisible to the reflection gate.
 * The message's content is a one-element tuple by construction, so the unwrap
 * needs no guard.
 * @param content - the tool-result message's content tuple.
 * @returns the text the tool produced; `''` when it produced none.
 */
function toolResultTextOf(content: readonly [ToolResultBlock]): string {
  return textOf(content[0].content)
}

/**
 * The skill one committed event loaded, or `undefined` when it loaded none.
 *
 * The single-event read the live listener needs; {@link loadedSkillNames} is
 * the same rule applied to a whole log, so the two can never disagree about
 * what counts as a load.
 * @param event - one committed session event.
 * @returns the loaded skill's name, or `undefined`.
 */
function loadedSkillIn(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') {
    const source = event.data.source
    return source.kind === 'skill-invocation' ? source.name : undefined
  }
  if (event.type !== 'tool/result') return undefined
  return loadedSkillName(toolResultTextOf(event.data.message.content))
}

/**
 * The skills a stretch of conversation actually loaded, in first-use order.
 *
 * Two paths can put a skill's body in front of the model, and both are read
 * from the log rather than tracked live, so a resumed session reports the same
 * answer as one that never left:
 *
 * - A USER-EXPLICIT invocation injects a `user/message` carrying the
 *   `skill-invocation` source, whose `name` is the skill. Reading the metadata
 *   is what the source exists for — the alternative is re-parsing the rendered
 *   body to recover something already recorded as a field.
 * - The model's `skill` tool returns the body as a `tool/result`, and the name
 *   is recovered through {@link loadedSkillName}, the inverse of the shared
 *   renderer. This is the only signal that survives presentation changes: under
 *   PTC the model calls `run_code` and the sub-dispatch settles as a
 *   `tool/result` too, so one read covers both faces.
 *
 * Duplicates collapse: a stretch that reloaded a skill five times used one
 * skill, and the reflection child needs the set, not the count.
 * @param events - committed session events in log order.
 * @returns the loaded skill names, first use first.
 */
export function loadedSkillNames(events: readonly SessionEvent[]): string[] {
  const names: string[] = []
  for (const event of events) {
    const name = loadedSkillIn(event)
    if (name !== undefined && name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Render one caught value as the command's error line.
 *
 * An `Error`'s `String()` carries an `Error: ` prefix that reads as noise in a
 * one-line result, so its message is preferred. Anything else — a string
 * thrown by a hook, a hostile `toString` — keeps `String`, which is what makes
 * this a helper rather than an inline ternary at each catch site.
 * @param error - the caught value.
 * @returns the one-line account of the failure.
 */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the child's prompt: capture instructions, optional guidance, plus the conversation excerpt.
 * @param turns - conversation excerpt the child distills the workflow from.
 * @param skillsDir - directory the skill bundle is written under.
 * @param guidance - user guidance defining what to capture; omitted uses the default rule.
 * @returns the child's prompt blocks.
 */
export function buildSummaryPrompt(turns: readonly ConversationTurn[], skillsDir: string, guidance?: string): ContentBlock[] {
  const listing = turns.map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`).join('\n\n')
  const text = [
    'You are capturing a reusable workflow from the conversation excerpt below.',
    'Decide whether it teaches a repeatable workflow worth saving as a skill; if it does, write the skill as markdown to',
    '`<skillsDir>/<kebab-name>/SKILL.md`',
    '(replace <skillsDir> with `' + skillsDir + '`; choose a descriptive kebab-case <kebab-name>).',
    'The SKILL.md frontmatter MUST contain `name:` (matching the directory name) and `description:` (one sentence saying when to use it); the body holds the distilled step-by-step workflow.',
    'Create the directory through the write tool — it creates missing parents.',
    'Finish by replying with the skill name you chose and a one-sentence summary.',
    ...(guidance === undefined
      ? ['If the excerpt teaches no reusable workflow, reply exactly `no reusable workflow` and write nothing.']
      : ['The user guidance below defines what to capture; do not second-guess it.',
        `User guidance: ${guidance}`]),
    '',
    'Conversation excerpt:',
    listing,
  ].join('\n')
  return [{ type: 'text', text }]
}

/** One skill this deployment owns, as the curation child sees it. */
export interface OwnedSkill {
  /** Skill name, as addressed by the `skill` tool. */
  readonly name: string
  /** One-line routing description, normalized and length-capped. */
  readonly description: string
  /** Absolute path of the instruction file, so the child can read or rewrite it. */
  readonly path: string
}

/** One owned skill handed to the curation child with its complete current text. */
export interface ReflectionTarget extends OwnedSkill {
  /** Current instruction body, exactly as loaded. */
  readonly content: string
}

/**
 * Whether one skill is both owned by this deployment and rewritable on disk.
 *
 * A skill with no `path` has no file to rewrite — a runtime or remote
 * contribution — and a source outside {@link CURATABLE_SOURCES} belongs to
 * someone else. Both are simply not reflection targets.
 * @param skill - one summary from the resolved catalog.
 * @returns whether the skill's file may be read and rewritten by the child.
 */
function isCuratable(skill: SkillSummary): skill is SkillSummary & { readonly path: string } {
  return CURATABLE_SOURCES.has(skill.source) && typeof skill.path === 'string' && skill.path !== ''
}

/**
 * Narrow a resolved catalog to the skills this deployment may reflect on.
 * @param skills - every winning summary in the calling agent's catalog.
 * @returns the owned, file-backed subset, in catalog order.
 */
export function curatableSkills(skills: readonly SkillSummary[]): (SkillSummary & { readonly path: string })[] {
  return skills.filter(isCuratable)
}

/**
 * Normalize one description to a single capped line for the listing.
 * @param value - the raw description, possibly multiline.
 * @param maxLength - maximum rendered length before the ellipsis.
 * @returns the normalized line.
 */
function oneLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/**
 * Whether a session's compaction may curate the corpus.
 *
 * A subagent's own compaction must not start a grandchild: the child was given
 * the parent's corpus to maintain, and a curation tree growing one level per
 * compaction is a runaway that nobody asked for. `origin` is the product-level
 * classification and `delegationDepth` the authoritative one, so either
 * signal is enough to stand down.
 * @param session - the session whose compaction just ended.
 * @returns whether curation may run for it.
 */
export function isCuratableSession(session: Session): boolean {
  if (session.header.origin === 'subagent') return false
  const depth = session.header.delegationDepth
  return depth === undefined || depth === 0
}

/**
 * The one paragraph both curation prompts share: what a SKILL.md is.
 *
 * Kept as one string rather than duplicated so the two children cannot drift
 * into asking for different file shapes — the corpus is read back by the
 * filesystem provider, which parses exactly one contract.
 */
const SKILL_FILE_CONTRACT = [
  'Every SKILL.md opens with frontmatter holding `name:` (matching the directory name) and `description:`',
  '(one sentence saying WHEN to use it — the sentence a request is matched against), followed by the body.',
  'The body is a procedure for a future session: the concrete steps, the exact commands and arguments, and the',
  'pitfalls that actually cost time. Do not write a report of what happened, and never mention this session,',
  'its user, or a date.',
]

/**
 * Build the CREATION child's prompt: should this work become a new skill?
 *
 * The child is given the corpus as a LISTING, not as bodies, and it may write
 * exactly one new file. Both are deliberate. The listing is the duplicate guard
 * — a second skill restating an existing one is worse than no new skill — and
 * the ban on editing existing files is what keeps this child's permission
 * disjoint from the reflection child's: two children that may both rewrite the
 * same path would race, and only reflection has the evidence to judge an
 * existing body.
 *
 * @param input - the summary, the skill root, the listed corpus, and the cap overflow count.
 * @returns the child's prompt blocks.
 */
export function buildCreationPrompt(input: {
  /** The compaction summary: what this session just did. */
  summary: string
  /** Skill root a NEW skill is written under; relative to the child's workspace. */
  skillsDir: string
  /** The owned skills the child is told about, already capped. */
  owned: readonly OwnedSkill[]
  /** How many owned skills the cap left out; `0` renders no overflow line. */
  omitted: number
}): ContentBlock[] {
  const listing = input.owned.map(skill => `- \`${skill.name}\`: ${skill.description}`)
  if (input.omitted > 0) listing.push(`- …and ${input.omitted} more this deployment owns.`)
  const text = [
    "You are deciding whether a piece of finished work should become a new entry in this agent's skill corpus —",
    'the reusable procedures it loads before acting on a task.',
    '',
    'A session has just compacted. Its summary is below, together with every skill this deployment owns.',
    'Answer one question: does the summary describe a repeatable procedure that the corpus does NOT already cover?',
    '',
    `If yes, write it as \`${input.skillsDir}/<kebab-name>/SKILL.md\` — choose a descriptive kebab-case name; the`,
    'write tool creates missing parent directories. If no, write nothing.',
    '',
    ...SKILL_FILE_CONTRACT,
    '',
    'Rules:',
    '- ONE new file at most. This is the only file you may write.',
    '- Never modify, move, or delete an existing skill. Correcting an existing skill is a different job that',
    '  someone else does, with evidence you were not given.',
    '- The listing is your duplicate guard: if a listed skill already covers this procedure — even under a',
    '  different name — write nothing. A skill whose content restates one that already exists is worse than',
    '  no new skill.',
    '- The body is a procedure, not a report. Never append, and never leave a placeholder or a TODO.',
    '- Prefer the specific truth over a general rule: if the procedure only works in this project, say so.',
    '- If the summary teaches nothing reusable, write nothing at all and reply exactly `nothing to save`.',
    '',
    ...input.owned.length === 0 && input.omitted === 0
      ? ['This deployment owns no skills yet; the corpus starts with whatever you create.']
      : ['Skills this deployment already owns:', ...listing],
    '',
    'Work just summarised:',
    input.summary.trim(),
  ].join('\n')
  return [{ type: 'text', text }]
}

/**
 * Build the REFLECTION child's prompt: was a skill that this session actually
 * loaded wrong?
 *
 * The evidence shape is the whole point. The child is handed the loaded skills
 * IN FULL — not a listing, not a ranking — because correcting a body it cannot
 * read would be guesswork, and it is told which of them the session opened.
 * That is also why the permission is inverted relative to creation: it may
 * rewrite the files it was handed and may create nothing. A skill nobody opened
 * was never exercised, so the caller does not run this child at all; a skill
 * that WAS opened but held up is a `nothing to improve` answer, not a rewrite.
 *
 * An empty target list prints a placeholder instead of an empty section, which
 * keeps this a total function over its input type. The pass never reaches that
 * case: an intersection that comes back empty is a decision NOT to run the
 * child, since there would be nothing to hand over.
 *
 * @param input - the summary and the loaded skills printed in full.
 * @returns the child's prompt blocks.
 */
export function buildReflectionPrompt(input: {
  /** The compaction summary: what this session just did. */
  summary: string
  /** The loaded skills, most recently used last, already capped. */
  targets: readonly ReflectionTarget[]
  /** How many older loaded skills the cap left out; `0` renders no overflow line. */
  omitted: number
}): ContentBlock[] {
  const printed: string[] = []
  for (const target of input.targets) {
    printed.push(
      `<loaded_skill name="${target.name}" path="${target.path}">`,
      target.content.trim(),
      '</loaded_skill>',
    )
  }
  const text = [
    "You are correcting this agent's skill corpus — the reusable procedures it loads before acting on a task —",
    'using the one kind of evidence that can show a skill to be wrong: a session that actually loaded it.',
    '',
    'A session has just compacted. Below are the skills it loaded, printed in full, and the summary of what the',
    'session did with them. Read the summary as the record of following these procedures.',
    '',
    'For each skill printed below, ask: did the work show its text to be wrong, incomplete, or ambiguous?',
    'The failure this exists to catch is a skill that sent the session down a path the summary shows was wrong,',
    'or left out something the session had to work out the hard way. A skill that held up is not a candidate.',
    '',
    ...SKILL_FILE_CONTRACT,
    '',
    'Rules:',
    '- Rewrite whole files with `write`, at the absolute paths printed above. Keep each skill\'s name.',
    '- Only the files printed above are in scope. Never create a skill, and never touch a file you were not given.',
    '- Never append, and never leave a placeholder or a TODO.',
    '- A skill the summary does not contradict is already correct — leave it exactly as it is.',
    '- If the work showed nothing in need of correction, write nothing at all and reply exactly `nothing to improve`.',
    '',
    ...printed.length === 0
      ? ['No skill was printed.']
      : ['Loaded by this session, in full:', ...printed],
    ...input.omitted > 0
      ? ['', `${input.omitted} earlier loaded skill(s) were left out of this printout; they are not in scope.`]
      : [],
    '',
    'Work just summarised:',
    input.summary.trim(),
  ].join('\n')
  return [{ type: 'text', text }]
}

/**
 * Assemble the creation child's corpus listing from one resolved catalog.
 *
 * Names, capped one-line descriptions, and — unlike the reflection printout —
 * no bodies: creation judges coverage, and a body it cannot see is a body it
 * cannot decide to edit.
 * @param skills - every winning summary in the calling agent's catalog.
 * @param maxListed - how many owned skills to name.
 * @returns the listing in catalog order and how many the cap left out.
 */
export function selectOwnedListing(
  skills: readonly SkillSummary[],
  maxListed: number,
): { owned: OwnedSkill[]; omitted: number } {
  const all = curatableSkills(skills).map(skill => ({
    name: skill.name,
    description: oneLine(skill.description, LISTED_DESCRIPTION_MAX),
    path: skill.path,
  }))
  return { owned: all.slice(0, maxListed), omitted: all.length - Math.min(all.length, maxListed) }
}

/**
 * Load, in the order the session used them, the loaded skills this deployment
 * may rewrite.
 *
 * The set is intersected with the owned corpus rather than trusted: a session can
 * load a bundled or another agent's skill, and neither may be handed over as a
 * file to rewrite. Bodies come from the same scoped lookup that produced the
 * summaries, so a skill deleted between the two calls is dropped instead of
 * handed over stale.
 *
 * The cap keeps the MOST RECENT uses, because the summary describes the work
 * just finished, and reports how many older ones it left out so the child knows
 * it is looking at a subset.
 * @param skills - every winning summary in the calling agent's catalog.
 * @param usedNames - skill names the stretch loaded, in first-use order.
 * @param maxTargets - how many loaded skills to print in full.
 * @param load - scoped loader for one skill's complete definition.
 * @returns the printed targets and how many older loaded skills the cap left out.
 */
export async function selectReflectionTargets(
  skills: readonly SkillSummary[],
  usedNames: readonly string[],
  maxTargets: number,
  load: (name: string) => Promise<{ readonly name: string; readonly content: string } | undefined>,
): Promise<{ targets: ReflectionTarget[]; omitted: number }> {
  const owned = new Map(curatableSkills(skills).map(skill => [skill.name, skill]))
  const loaded = [...new Set(usedNames)].flatMap((name) => {
    const skill = owned.get(name)
    return skill === undefined ? [] : [skill]
  })
  const printed = loaded.slice(-maxTargets)
  const targets: ReflectionTarget[] = []
  for (const candidate of printed) {
    const definition = await load(candidate.name)
    if (definition === undefined) continue
    targets.push({
      name: definition.name,
      description: oneLine(candidate.description, LISTED_DESCRIPTION_MAX),
      path: candidate.path,
      content: definition.content,
    })
  }
  return { targets, omitted: loaded.length - printed.length }
}

/** Register the command when the command registry is composed. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  registerSummaryCommand(ctx, resolved)
  if (resolved.autoCurate) registerCurationPass(ctx, resolved)
}

/** Register the `/summarize-skill` command. */
function registerSummaryCommand(ctx: Context, resolved: ResolvedConfig): void {
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'summarize-skill',
      description: 'Turn the conversation — optional [N|N-M] selection plus guidance — into a project skill file.',
      handler: async ({ agent, signal, rawInput }) => {
        let input: SummaryInput
        try {
          input = parseSummaryInput(rawInput)
        } catch (error) {
          return { kind: 'error', text: failureText(error) }
        }
        const session: Session = agent.session
        const allTurns = recentTurns(session.snapshotEvents())
        let turns: ConversationTurn[]
        try {
          turns = selectTurns(allTurns, input)
        } catch (error) {
          return { kind: 'error', text: failureText(error) }
        }
        if (resolved.maxTurns !== undefined) turns = turns.slice(-resolved.maxTurns)
        if (turns.length === 0) {
          return { kind: 'error', text: 'summarize-skill found no conversation text to capture yet' }
        }
        const subagents = ctx.get('subagents')
        if (subagents === undefined) {
          return { kind: 'error', text: 'summarize-skill requires a subagent runtime; mount @deepseek-ai/dsh-subagent with a provider backend' }
        }
        const cwd = agent.session.header.cwd
        if (cwd === undefined) {
          return { kind: 'error', text: 'summarize-skill requires a session with a working directory' }
        }
        const skillsRoot = isAbsolute(resolved.skillsDir) ? resolved.skillsDir : join(cwd, resolved.skillsDir)
        try {
          const run = await subagents.start(resolved.provider, {
            label: 'skill-summary',
            prompt: buildSummaryPrompt(turns, resolved.skillsDir, input.guidance),
            parent: agent,
            signal,
            // 空名单不传：字面上它意味着"一个工具都不留"，那样的子 agent 写不出
            // 技能文件。把空数组读作"别动它的工具集"，误配才会落到可用的一侧。
            ...resolved.childTools.length > 0 ? { allowTools: resolved.childTools } : {},
            ...resolved.childOmitSections.length > 0 ? { omitSections: resolved.childOmitSections } : {},
          })
          return {
            kind: 'success',
            text: `Summary child ${String(run.id)} started in the background; it will write the skill under ${skillsRoot}. Track it on the subagent surface.`,
          }
        } catch (error) {
          return { kind: 'error', text: `summarize-skill could not start the summary child: ${String(error)}` }
        }
      },
    })
  })
}

/**
 * Arm the automatic pass.
 *
 * The pass is driven by two session events: `compaction/summary` hands over the
 * text to learn from, and `compaction/end` is the boundary that acts on it.
 * Pairing them through a per-session slot rather than re-reading the log keeps
 * "which summary belongs to this end" exact — compactions are serialized per
 * session, so the newest summary is always the one the boundary closes.
 * @param ctx - owning plugin context.
 * @param resolved - validated configuration.
 */
function registerCurationPass(ctx: Context, resolved: ResolvedConfig): void {
  /** The newest compaction summary per session, waiting for its boundary. */
  const pending = new Map<SessionId, string>()
  /**
   * Skills each session loaded since its last boundary, first use first.
   *
   * Accumulated as events arrive rather than re-walked at the boundary: a
   * resumed session replays its log in order, so the same accumulate-then-clear
   * sequence reproduces the same window a walk would.
   */
  const touched = new Map<SessionId, string[]>()
  /** Sessions whose curation children have not settled yet: one pass at a time. */
  const inFlight = new Set<SessionId>()
  const controllers = new Set<AbortController>()
  ctx.effect(() => () => {
    for (const controller of controllers) controller.abort()
    controllers.clear()
    inFlight.clear()
    pending.clear()
    touched.clear()
  })
  ctx.on('session/event', (session, event) => {
    const id = session.header.id
    const loaded = event.type === 'compaction/end' ? undefined : loadedSkillIn(event)
    if (loaded !== undefined && loaded !== '') {
      const seen = touched.get(id) ?? []
      if (!seen.includes(loaded)) seen.push(loaded)
      touched.set(id, seen)
    }
    if (event.type === 'compaction/summary') {
      pending.set(id, textOf(event.data.summary))
      return
    }
    if (event.type !== 'compaction/end') return
    const summary = pending.get(id)
    pending.delete(id)
    // 窗口在这里就结束：这一段工作已经总结完，无论下面是否真的起子 agent，
    // 它加载过的技能都不该被下一段工作重新算一遍。
    const used = touched.get(id) ?? []
    touched.delete(id)
    // 压缩失败意味着没有可依据的摘要，而且那一刻会话本身最不可信：放开手让它
    // 改技能语料是双重坏事，所以这一次边界什么都不做。
    if (event.data.error !== undefined) return
    if (summary === undefined || summary.trim() === '') return
    if (!isCuratableSession(session)) return
    // 前一个策展子 agent 还没落地就不再起新的：它们会读到同一份语料，同时写
    // 会互相覆盖，而第二次压缩离第一次往往只有几步。
    if (inFlight.has(id)) return
    const controller = new AbortController()
    controllers.add(controller)
    inFlight.add(id)
    void runCuration(ctx, resolved, session, summary, used, controller.signal)
      .catch((error: unknown) => {
        ctx.logger.warn(`skill-curation: session ${String(id)} could not be curated: ${String(error)}`)
      })
      .finally(() => {
        controllers.delete(controller)
        inFlight.delete(id)
      })
  })
}

/**
 * Run one curation pass: reflect on the skills the stretch loaded, then ask
 * whether the corpus should grow. Settles only once BOTH children have.
 *
 * Every early return here is a decision to leave the corpus alone, not a
 * failure: the pass is opportunistic and the session's own turn never waits on
 * it. The settlement wait is what makes the caller's in-flight mark span the
 * children's WHOLE life — publishing is not finishing, and two children editing
 * one corpus at once would overwrite each other. One mark covers both children
 * because they share the corpus; a second boundary arriving mid-pass is dropped
 * rather than queued, the same rule that already governs a single child.
 *
 * Reflection runs FIRST and creation is handed a listing taken after it, so the
 * procedure a rewrite just sharpened reads as already covered rather than
 * absent. When nothing loaded is ours there is no reflection child, no second
 * listing, and creation runs against the listing already in hand.
 * @param ctx - owning plugin context.
 * @param resolved - validated configuration.
 * @param session - the session whose compaction just ended.
 * @param summary - the compaction summary text.
 * @param used - skill names the stretch loaded, first use first.
 * @param signal - aborts the pass when the plugin is disposed.
 * @returns a promise that resolves once both children have settled and been released.
 */
async function runCuration(
  ctx: Context,
  resolved: ResolvedConfig,
  session: Session,
  summary: string,
  used: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const subagents = ctx.get('subagents')
  const skills = ctx.get('skills')
  // 调用方 agent 同时是子 agent 的父会话与技能查询的作用域；它没了（会话已
  // 卸载）就没有可挂的父子关系，也没有"这份语料对谁可见"的答案。
  const agent = ctx.get('agents')?.get(session.header.id)
  if (subagents === undefined || skills === undefined || agent === undefined) return
  const cwd = session.header.cwd
  const lookup = { ...cwd === undefined ? {} : { cwd }, signal, scope: agent }
  const load = async (skillName: string): Promise<{ readonly name: string; readonly content: string } | undefined> => {
    const definition = await skills.get(skillName, lookup)
    signal.throwIfAborted()
    return definition === undefined ? undefined : { name: definition.name, content: definition.content }
  }
  const start = (label: string, prompt: ContentBlock[]): Promise<{ result: Promise<unknown>; dispose(): Promise<void> }> =>
    subagents.start(resolved.provider, {
      label,
      prompt,
      parent: agent,
      signal,
      ...resolved.childTools.length > 0 ? { allowTools: resolved.childTools } : {},
      ...resolved.childOmitSections.length > 0 ? { omitSections: resolved.childOmitSections } : {},
    })

  // 不完整的目录不能当依据：没看到的那部分正是"已经有人写过了"的证据，而重复
  // 造一个技能比不写更糟。
  const opening = await skills.snapshot(lookup)
  signal.throwIfAborted()
  if (!opening.complete) return

  const { targets, omitted } = await selectReflectionTargets(opening.skills, used, resolved.curateMaxTargets, load)
  signal.throwIfAborted()
  let corpus = opening
  // 交不出文件就不起反思子 agent：本段加载过的技能可能一个都不归本部署所有
  // （随包发布的只读技能、别的工具也在用的共享目录），改写它们等于替别人的程序
  // 动文件。没有可交付的正文，这次反思就没有依据，也没有活可干。
  if (targets.length > 0) {
    await drain(await start('skill-reflection', buildReflectionPrompt({ summary, targets, omitted })))
    // 反思刚改写过的文件会让目录失效（实际部署里由 provider 的 watcher 触发）。
    // 重新取一次清单：拿旧清单会让创建把刚被修好的那条当成"尚未覆盖"。
    corpus = await skills.snapshot(lookup)
    signal.throwIfAborted()
    if (!corpus.complete) return
  }

  const listing = selectOwnedListing(corpus.skills, resolved.curateMaxListedSkills)
  await drain(await start('skill-creation', buildCreationPrompt({
    summary,
    skillsDir: resolved.skillsDir,
    owned: listing.owned,
    omitted: listing.omitted,
  })))
}

/**
 * Publish one background child and hold it until it settles.
 *
 * `dispose()` cancels unfinished work, so it must never run before the result
 * has settled — the child has not taken a single step when `start()` returns.
 * The child's OWN failure (model or transport) is its own result and not this
 * boundary's business; a disposal failure after publication is infrastructure
 * trouble the caller has to see.
 * @param run - the published run.
 * @returns a promise that resolves once the child has settled and been released.
 */
async function drain(run: { result: Promise<unknown>; dispose(): Promise<void> }): Promise<void> {
  await run.result.catch(() => undefined)
  await run.dispose()
}
