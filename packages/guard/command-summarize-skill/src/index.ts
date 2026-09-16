/**
 * The `/summarize-skill` command: a user-invoked capture pass over the recent
 * conversation. The handler extracts the user/assistant text turns — the full
 * main-line conversation by default — from the receiving agent's session and
 * starts ONE background one-shot subagent
 * whose prompt carries the excerpt and orders it to write a reusable workflow
 * as a project skill file (`<skillsDir>/<kebab-name>/SKILL.md`). The command
 * runs no model work itself; the child runs independently of the main
 * conversation, and the skill filesystem provider watches the directory, so
 * the new skill appears in the catalog without any manual invalidation.
 *
 * @module @deepseek-ai/dsh-command-summarize-skill
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx.commands and ctx.subagents service merges.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'

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
 * 后两者只会把提示词撑长，而子 agent 的判断依据应当只有它收到的这段会话。
 */
const DEFAULT_CHILD_OMIT_SECTIONS = ['harness:identity', 'deployment:persona', 'deployment:error-lessons']

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  skillsDir: z.string().min(1).default('.dsh/skills'),
  maxTurns: z.number().step(1).min(1),
  provider: z.string().min(1).default('spawn'),
  childTools: z.array(z.string()).default([...DEFAULT_CHILD_TOOLS]),
  childOmitSections: z.array(z.string()).default([...DEFAULT_CHILD_OMIT_SECTIONS]),
})


/** Resolve and validate configuration; misconfiguration fails at load. */
export function resolveConfig(config: Config): {
  skillsDir: string
  maxTurns: number | undefined
  provider: string
  childTools: readonly string[]
  childOmitSections: readonly string[]
} {
  const maxTurns = config.maxTurns
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw new Error('command-summarize-skill: maxTurns must be a positive integer')
  }
  return {
    skillsDir: config.skillsDir ?? '.dsh/skills',
    maxTurns,
    provider: config.provider ?? 'spawn',
    childTools: config.childTools ?? DEFAULT_CHILD_TOOLS,
    childOmitSections: config.childOmitSections ?? DEFAULT_CHILD_OMIT_SECTIONS,
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
    const countText = last[1]
    if (countText === undefined) throw new Error('summarize-skill: malformed turn count')
    const count = Number(countText)
    if (count < 1) throw new Error(`summarize-skill: turn count must be >= 1 (got ${count})`)
    const guidance = trimmed.slice(countText.length).trim()
    return guidance === '' ? { last: count } : { last: count, guidance }
  }
  return { guidance: trimmed }
}

/** Apply the parsed selection to the full conversation. */
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

/** Build the child's prompt: capture instructions, optional guidance, plus the conversation excerpt. */
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

/** Register the command when the command registry is composed. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'summarize-skill',
      description: 'Turn the conversation — optional [N|N-M] selection plus guidance — into a project skill file.',
      handler: async ({ agent, signal, rawInput }) => {
        let input: SummaryInput
        try {
          input = parseSummaryInput(rawInput)
        } catch (error) {
          return { kind: 'error', text: String(error instanceof Error ? error.message : error) }
        }
        const session: Session = agent.session
        const allTurns = recentTurns(session.snapshotEvents())
        let turns: ConversationTurn[]
        try {
          turns = selectTurns(allTurns, input)
        } catch (error) {
          return { kind: 'error', text: String(error instanceof Error ? error.message : error) }
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
