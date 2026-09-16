/**
 * The `/correct-errors` command: a user-invoked correction pass that fuses the
 * tool error journal with the existing system-level reflection document. The
 * handler reads the journal and the prior lessons, starts ONE background
 * one-shot subagent ordered to write the merged reflection document, then
 * appends the raw journal content to the append-only archive and clears the
 * journal so the next pass starts fresh. The command itself never runs model
 * work; the child runs independently of the main conversation.
 *
 * The document is sectioned by subject (`## tool:read`, `## mcp:github`, …), and
 * the child is told to keep it that way, so each ability's lessons end up under
 * that ability's own prompt section rather than in one global pile.
 *
 * @module @deepseek-ai/dsh-command-correct-errors
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the ctx.commands and ctx.subagents service merges.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ToolErrorEntry } from '@deepseek-ai/dsh-tool-error-journal'

export const name = 'command-correct-errors'

const DEFAULT_JOURNAL = 'tool-error-log.jsonl'
const DEFAULT_ARCHIVE = 'tool-error-log-archive.jsonl'
const DEFAULT_REFLECTIONS = 'error-reflections.md'
const DEFAULT_MAX_REFLECTION_CHARS = 8000

/** Plugin configuration. */
export interface Config {
  /**
   * Tool error journal to read; a relative path resolves under the Harness
   * home. Defaults to the journal package's own default file name.
   */
  journalPath?: string
  /** Append-only archive every cleared journal lands in; relative paths resolve under the Harness home. */
  archivePath?: string
  /**
   * System-level reflection document the child rewrites; a relative path
   * resolves under the Harness home, so lessons persist across projects.
   */
  reflectionDocPath?: string
  /** Subagent provider that runs the correction child. */
  provider?: string
  /** Maximum journal entries handed to the child, newest last. */
  maxErrors?: number
  /** Tail cap on the existing reflection document handed to the child. */
  maxReflectionChars?: number
  /**
   * Tools the correction child keeps; every other inherited tool is removed.
   * Defaults to reading and writing — see {@link DEFAULT_CHILD_TOOLS}.
   */
  childTools?: string[]
  /**
   * Prompt sections the correction child does not get; defaults to deployment
   * identity, persona, and the error-lessons section itself. An empty list is
   * honored as written: it suppresses nothing.
   */
  childOmitSections?: string[]
}

/**
 * Tools the correction child keeps.
 *
 * 这份名单比"看起来该给什么"短得多，因为子 agent 的任务是**改写一份文档**：
 * 需要的信息 —— 既有文档全文与失败清单 —— 已经在提示词里，所以 shell、搜索、
 * 委派、计划、待办这些能力对它没有一处是必需的。保留 `read` 只是让它能确认目标
 * 文件的现状；真正必需的是 `write`，命令的提示词也点名要求它。
 */
const DEFAULT_CHILD_TOOLS = ['read', 'write']

/**
 * Prompt sections the correction child does not get.
 *
 * `harness:identity` 与 `deployment:persona` 描述的是一个编码 agent，而这里跑的
 * 是一个文档编辑任务；`deployment:error-lessons` 则是**这个子 agent 正在改写的
 * 那份文档本身**——把它连同旧经验一起注入，等于让改写者把自己的输出当成经验读。
 */
const DEFAULT_CHILD_OMIT_SECTIONS = ['harness:identity', 'deployment:persona', 'deployment:error-lessons']

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  journalPath: z.string(),
  archivePath: z.string(),
  reflectionDocPath: z.string(),
  provider: z.string().min(1).default('spawn'),
  maxErrors: z.number().step(1).min(1).default(20),
  maxReflectionChars: z.number().step(1).min(200).default(DEFAULT_MAX_REFLECTION_CHARS),
  childTools: z.array(z.string()).default([...DEFAULT_CHILD_TOOLS]),
  childOmitSections: z.array(z.string()).default([...DEFAULT_CHILD_OMIT_SECTIONS]),
})


/** Resolve and validate configuration; misconfiguration fails at load. */
export function resolveConfig(config: Config): {
  journalPath: string
  archivePath: string
  reflectionDocPath: string
  provider: string
  maxErrors: number
  maxReflectionChars: number
  childTools: readonly string[]
  childOmitSections: readonly string[]
} {
  const maxErrors = config.maxErrors ?? 20
  if (!Number.isInteger(maxErrors) || maxErrors < 1) {
    throw new Error('command-correct-errors: maxErrors must be a positive integer')
  }
  const maxReflectionChars = config.maxReflectionChars ?? DEFAULT_MAX_REFLECTION_CHARS
  if (!Number.isInteger(maxReflectionChars) || maxReflectionChars < 200) {
    throw new Error('command-correct-errors: maxReflectionChars must be an integer >= 200')
  }
  const home = resolveDshHome()
  const underHome = (value: string) => isAbsolute(value) ? resolve(value) : join(home, value)
  const journal = config.journalPath ?? DEFAULT_JOURNAL
  const archive = config.archivePath ?? DEFAULT_ARCHIVE
  const reflection = config.reflectionDocPath ?? DEFAULT_REFLECTIONS
  const provider = config.provider ?? 'spawn'
  return {
    journalPath: underHome(journal),
    archivePath: underHome(archive),
    reflectionDocPath: underHome(reflection),
    provider,
    maxErrors,
    maxReflectionChars,
    childTools: config.childTools ?? DEFAULT_CHILD_TOOLS,
    childOmitSections: config.childOmitSections ?? DEFAULT_CHILD_OMIT_SECTIONS,
  }
}

/** Read the whole journal file; an absent journal reads as empty. */
export async function readJournalFile(path: string): Promise<string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return ''
    throw error
  }
  return raw
}

/** Parse the newest journal entries out of raw journal text, newest last. */
export function parseRecentEntries(raw: string, max: number): ToolErrorEntry[] {
  return raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-max)
    .map(line => JSON.parse(line) as ToolErrorEntry)
}

/** Read the capped tail of the reflection document; an absent document reads as empty. */
export async function readReflectionsTail(path: string, maxChars: number): Promise<string> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return ''
    throw error
  }
  return raw.length <= maxChars ? raw : raw.slice(-maxChars)
}

/**
 * Append the raw journal content to the archive (creating parent directories)
 * and clear the journal. The archive is the only place every recorded failure
 * survives; the journal restarts empty for the next pass.
 */
export async function archiveAndClearJournal(journalPath: string, archivePath: string, raw: string): Promise<void> {
  if (raw.trim() === '') return
  await mkdir(dirname(archivePath), { recursive: true })
  await appendFile(archivePath, raw.endsWith('\n') ? raw : `${raw}\n`)
  await writeFile(journalPath, '')
}

/**
 * Build the child's prompt: reflection instructions plus the failure records.
 *
 * 文档按**主题**分节，不按日期。经验是"属于某个能力"的：模型在调用 `read` 时
 * 需要的是 `read` 自己的坑，把 `read` 和 `mcp__github__search` 的教训混在一节里，
 * 等于让它在现场自己挑。主题键与提示词分段同名，注入侧才能把一节经验追加到对应
 * 能力的分段后面。
 */
export function buildReflectionPrompt(
  entries: readonly ToolErrorEntry[],
  priorReflections: string,
  reflectionDocPath: string,
): ContentBlock[] {
  const listing = entries.map((entry, index) => {
    const internal = entry.internalError === undefined
      ? ''
      : ` [internal: ${entry.internalError.name}/${entry.internalError.code}]`
    return `${index + 1}. [${entry.time}] ${entry.name} (call ${entry.callId})${internal}: ${entry.text}`
  }).join('\n')
  const prior = priorReflections.trim() === ''
    ? '目前还没有历史经验；请创建文档。'
    : ['既有经验（新的在最后）：', priorReflections.trim()].join('\n')
  const text = [
    '你在维护工具错误反思文档。',
    `把下面的新失败与既有经验合并，用 write 工具把完整文档写入 \`${reflectionDocPath}\`。`,
    '文档按主题分节，每个能力一个 `## <主题键>` 小节，主题键取失败记录里的工具名：',
    '- 第一方工具：`## tool:<工具名>`，例如 `## tool:read`。',
    '- MCP 工具：工具名形如 `mcp__<服务器名>__<原名>`，统一归到 `## mcp:<服务器名>` 一节。',
    '- 电脑操作：`## computer:policy`。',
    '同一个小节最多 5 条要点，每条只写根因、修复方法和预防方式；不要复述完整错误日志，也不要为同一次失败重复开小标题。',
    '既有文档可能还是老格式（按日期分节、没有主题键）。**按内容把它迁到主题小节**：能从工具名、报错现象或失败记录判断出属于哪个能力，就并进对应小节，合并重复、去掉日期标题。',
    '只有确实归不到任何能力的内容（通用原则、用户自己写的随笔）才保持原样保留在文件开头，不要改写、不要删除。',
    '任何一条仍然有效的旧经验都必须在合并后的文档里留有等价表述——迁移不等于可以丢内容。',
    '必须输出完整文档，不要追加片段。',
    '完成后用一句话说明更新了哪些主题。',
    '',
    prior,
    '',
    '最近失败（从旧到新）：',
    listing,
  ].join('\n')
  return [{ type: 'text', text }]
}

/** Register the command when the command registry is composed. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'correct-errors',
      description: 'Fuse the tool error journal with the prior lessons into the reflection document, archive the raw failures, and clear the journal.',
      handler: async ({ agent, signal }) => {
        let raw: string
        try {
          raw = await readJournalFile(resolved.journalPath)
        } catch (error) {
          return { kind: 'error', text: `correct-errors could not read the error journal: ${String(error)}` }
        }
        const entries = parseRecentEntries(raw, resolved.maxErrors)
        if (entries.length === 0) {
          return { kind: 'success', text: 'No tool errors recorded; nothing to correct.' }
        }
        let prior: string
        try {
          prior = await readReflectionsTail(resolved.reflectionDocPath, resolved.maxReflectionChars)
        } catch (error) {
          return { kind: 'error', text: `correct-errors could not read the reflection document: ${String(error)}` }
        }
        const subagents = ctx.get('subagents')
        if (subagents === undefined) {
          return { kind: 'error', text: 'correct-errors requires a subagent runtime; mount @deepseek-ai/dsh-subagent with a provider backend' }
        }
        try {
          const run = await subagents.start(resolved.provider, {
            label: 'tool-error-correction',
            prompt: buildReflectionPrompt(entries, prior, resolved.reflectionDocPath),
            parent: agent,
            signal,
            // 空名单不传。字面上它意味着"一个工具都不留"，而这样的子 agent 连
            // 文档都写不出去——没有一个部署会想要那个结果，所以空数组在这里读作
            // "别动它的工具集"，把误配引向可用的一侧。
            ...resolved.childTools.length > 0 ? { allowTools: resolved.childTools } : {},
            ...resolved.childOmitSections.length > 0 ? { omitSections: resolved.childOmitSections } : {},
          })
          try {
            await archiveAndClearJournal(resolved.journalPath, resolved.archivePath, raw)
          } catch (error) {
            return { kind: 'error', text: `correction child ${String(run.id)} started, but archiving/clearing the journal failed: ${String(error)}` }
          }
          return {
            kind: 'success',
            text: `Correction child ${String(run.id)} started in the background; it will rewrite ${resolved.reflectionDocPath}. The journal was archived to ${resolved.archivePath} and cleared. Track the child on the subagent surface.`,
          }
        } catch (error) {
          return { kind: 'error', text: `correct-errors could not start the correction child: ${String(error)}` }
        }
      },
    })
  })
}
