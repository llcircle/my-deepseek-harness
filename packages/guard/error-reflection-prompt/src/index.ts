/**
 * Injects the deployment's tool-error reflection document into the system
 * prompt. The document (default `<dshHome>/error-reflections.md`, the same file
 * `/correct-errors` maintains) is sectioned by subject — `## tool:read`,
 * `## mcp:github`, `## computer:policy` — and this plugin routes each section to
 * the prompt section of the same name, so a tool's lessons sit directly under
 * that tool's own guidance instead of in one global pile the model has to sort
 * out itself. Sections whose subject matches no section in the current assembly
 * are simply not injected: an ability that is not composed in this session must
 * not advertise itself through stale lessons.
 *
 * MCP tools are the one exception: a server contributes a single prompt section
 * (`mcp:<server>`) but each of its tools keeps its own subject
 * (`mcp__<server>__<tool>`). Those subjects have no section to land in, so they
 * are appended to their server's section as `### <tool>` blocks, sorted by tool
 * name, with the server's own lessons ahead of them. Each subject is capped on
 * its own (`maxSubjectChars`) — one chatty tool must not crowd out its
 * siblings the way it must not crowd out another ability.
 *
 * Whatever is left over — prose before the first heading, legacy `## YYYY-MM-DD`
 * blocks, hand-written notes with a title that names no subject — still lands in
 * the `deployment:error-lessons` section, capped, exactly as before. Upgrading
 * the document format must not silently drop lessons already on disk.
 *
 * The document is re-read on every assembly (cached by mtime/size so one
 * assembly costs one read), **but only a compaction boundary lets a changed
 * document through**. Lessons are a prompt section, so a file edit mid-turn
 * would rewrite the head of the next request and void that session's whole
 * cache prefix — and this document is exactly the asset something rewrites while
 * a session runs (the very agent that just learned the lesson). Compaction is
 * the one moment the prefix is rebuilt anyway, so a new pass is admitted there
 * and nowhere else; until then the last parsed snapshot keeps being served. An
 * absent or empty document contributes nothing at all.
 *
 * @module @deepseek-ai/dsh-error-reflection-prompt
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
// Type-only: pulls the `compaction/end` session-event declaration this file gates on.
import type {} from '@deepseek-ai/dsh-compaction/types'
// Type-only: the `session/event` hook this file listens on.
import type {} from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  mcpToolSubjectPrefix,
  parseReflectionDocument,
  type ReflectionDocument,
} from '@deepseek-ai/dsh-tool-error-journal'
// Type-only: pulls the ctx.systemPrompt merge.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'error-reflection-prompt'

/** Name of the section carrying the document's global, subject-less text. */
export const SECTION_NAME = 'deployment:error-lessons'

/** Default per-subject cap, so one chatty ability cannot crowd out the rest. */
const DEFAULT_MAX_SUBJECT_CHARS = 1200

/**
 * 一个 MCP 服务器分段的准确形状，即 `mcp:<serverName>`。
 *
 * 刻意只认两段：`mcp:github:search` 这种写法不在主题键的语法里，工具主题一律是
 * 公开工具名（`mcp__github__search`）。宽松匹配会把一个笔误当成服务器。
 */
const MCP_SERVER_SECTION = /^mcp:([A-Za-z0-9_-]{1,32})$/

/** Plugin configuration. */
export interface Config {
  /** Reflection document to read; a relative path resolves under the Harness home. */
  docPath?: string
  /** Tail cap on the document's global text contributed to the prompt. */
  maxPromptChars?: number
  /** Cap on ONE subject's lessons contributed to that subject's section. */
  maxSubjectChars?: number
}

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  docPath: z.string().min(1),
  maxPromptChars: z.number().step(1).min(200),
  maxSubjectChars: z.number().step(1).min(200),
})

/**
 * Resolve and validate configuration; misconfiguration fails at load.
 * @param config - plugin configuration; every field is optional.
 * @returns the absolute document path plus the prompt and per-subject caps.
 */
export function resolveConfig(config: Config): {
  docPath: string
  maxPromptChars: number
  maxSubjectChars: number
} {
  const maxPromptChars = config.maxPromptChars ?? 6000
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < 200) {
    throw new Error('error-reflection-prompt: maxPromptChars must be an integer >= 200')
  }
  const maxSubjectChars = config.maxSubjectChars ?? DEFAULT_MAX_SUBJECT_CHARS
  if (!Number.isInteger(maxSubjectChars) || maxSubjectChars < 200) {
    throw new Error('error-reflection-prompt: maxSubjectChars must be an integer >= 200')
  }
  const docPath = config.docPath ?? 'error-reflections.md'
  return {
    docPath: isAbsolute(docPath) ? resolve(docPath) : join(resolveDshHome(), docPath),
    maxPromptChars,
    maxSubjectChars,
  }
}

/**
 * 反思文档的换新闸门：只在压缩边界之后放行。
 *
 * 这是**部署级**而非会话级语义，而且是有意的：文档本身是全局资产
 * （`<dshHome>/error-reflections.md`），承接它的分段也是全局分段，所以"是哪一次压缩
 * 触发的换新"并不重要。重要的是换新只发生在缓存本来就要重建的那些时刻，而不是每次
 * 文件落盘。整份文档要么整体沿用旧快照、要么整体换新，不会出现半新半旧的分段。
 */
export class ReflectionRefreshGate {
  private due = false

  /** 记一次压缩边界；此后第一次真正需要换新时据此放行。 */
  markBoundary(): void {
    this.due = true
  }

  /**
   * 取一次许可。
   * @returns 自上次取用以来出现过压缩边界时为 `true`；取走即清零，一次边界只放行一次。
   */
  take(): boolean {
    const allowed = this.due
    this.due = false
    return allowed
  }
}

/** Cut the capped tail on a `## ` heading boundary when possible. */
function tailFromHeadingBoundary(trimmed: string, maxChars: number): string {
  if (trimmed.length <= maxChars) return trimmed
  const cut = trimmed.slice(-maxChars)
  const boundary = cut.indexOf('\n## ')
  return boundary === -1 ? cut : cut.slice(boundary + 1)
}

/** 单个主题的经验在提示词里的抬头；整节只写一次。 */
const SUBJECT_HEADING = '以下是这项能力过往失败的教训（自动生成）：'

/**
 * The section text for the document's global part; empty when there is none.
 * @param raw - the document's global, subject-less text.
 * @param maxPromptChars - tail cap, applied on a `## ` boundary when one exists.
 * @returns the headed section text, or `''` when the global text is blank.
 */
export function lessonsSectionText(raw: string, maxPromptChars: number): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return [
    '以下是从过去工具失败中总结的经验（自动生成，最新在最后）：',
    '',
    tailFromHeadingBoundary(trimmed, maxPromptChars),
  ].join('\n')
}

/**
 * 一个主题的经验正文，不含抬头。
 * @param raw - that subject's own lessons.
 * @param maxSubjectChars - tail cap, applied on a `## ` boundary when one exists.
 * @returns the body, or `''` when the subject has no lessons.
 */
function subjectBodyText(raw: string, maxSubjectChars: number): string {
  const trimmed = raw.trim()
  return trimmed === '' ? '' : tailFromHeadingBoundary(trimmed, maxSubjectChars)
}

/**
 * The appended text for ONE subject's lessons; empty when that subject has none.
 * @param raw - that subject's own lessons.
 * @param maxSubjectChars - tail cap, applied on a `## ` boundary when one exists.
 * @returns the headed text, or `''` when the subject has no lessons.
 */
export function subjectLessonsText(raw: string, maxSubjectChars: number): string {
  const body = subjectBodyText(raw, maxSubjectChars)
  return body === '' ? '' : [SUBJECT_HEADING, '', body].join('\n')
}

/**
 * 一个分段该收到的全部经验正文（不含抬头）：它自己的，加上它名下各个 MCP 工具
 * 的各一条。
 *
 * 工具主题没有自己的提示词分段可挂，只能落进服务器的分段里。用 `### <工具>`
 * 分块而不是揉成一段散文，是为了让模型看得出"这条坑属于哪个工具"——同一服务器
 * 的工具往往长得很像，混在一起的经验反而会误导。
 *
 * 每个主题各自截尾：一个话多的工具挤掉的该是它自己的后半段，不是它兄弟的整块。
 *
 * @param document - 已解析的反思文档。
 * @param sectionName - 正在装配的分段名。
 * @param maxSubjectChars - 单个主题的截尾上限。
 * @returns 该分段的经验正文；一条经验都没有时为空串。
 */
export function sectionLessonsText(
  document: ReflectionDocument,
  sectionName: string,
  maxSubjectChars: number,
): string {
  const parts: string[] = []
  const own = subjectBodyText(document.subjects.get(sectionName) ?? '', maxSubjectChars)
  if (own !== '') parts.push(own)
  const server = MCP_SERVER_SECTION.exec(sectionName)?.[1]
  if (server !== undefined) {
    const prefix = mcpToolSubjectPrefix(server)
    for (const subject of [...document.subjects.keys()].sort((a, b) => a.localeCompare(b))) {
      if (!subject.startsWith(prefix) || subject.length === prefix.length) continue
      const body = subjectBodyText(document.subjects.get(subject) ?? '', maxSubjectChars)
      if (body !== '') parts.push(`### ${subject.slice(prefix.length)}\n\n${body}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Read and parse the reflection document, serving the last parse until a
 * compaction boundary admits a change. Assembly asks once for the global text
 * and once per section for that section's lessons, so without the reuse one
 * assembly would re-read the file dozens of times.
 * @param path - absolute document path.
 * @param permit - asked only when the file changed: whether the change may replace the cached parse now.
 * @returns the parsed document; an absent file parses as empty.
 */
function reader(path: string, permit: () => boolean): () => ReflectionDocument {
  let cached: { key: string; document: ReflectionDocument } | undefined
  return () => {
    let key = 'absent'
    try {
      const stats = statSync(path)
      key = `${stats.mtimeMs}:${stats.size}`
    } catch (error) {
      // A missing document means no lessons exist yet; other failures propagate.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    if (cached?.key === key) return cached.document
    // 首次读取必须真的读一次——还没有任何快照可比。此后再变，就要等压缩边界放行：
    // 分段落在请求头部，中途换新会把整个会话的缓存前缀作废。
    if (cached !== undefined && !permit()) return cached.document
    const document = key === 'absent'
      ? parseReflectionDocument('')
      : parseReflectionDocument(readFileSync(path, 'utf8'))
    cached = { key, document }
    return document
  }
}

/** Register the lessons section and the per-subject reflection source. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const gate = new ReflectionRefreshGate()
  // 压缩边界是唯一的放行点；事件是全局的，闸门也按部署级语义工作。
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'compaction/end' && event.data.error === undefined) gate.markBoundary()
  })
  const read = reader(resolved.docPath, () => gate.take())
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: SECTION_NAME,
      order: promptCtx.systemPrompt.getSectionOrder('ERROR_LESSONS'),
      text: () => lessonsSectionText(read().global, resolved.maxPromptChars),
    })
    promptCtx.systemPrompt.reflectionSource((sectionName) => {
      const body = sectionLessonsText(read(), sectionName, resolved.maxSubjectChars)
      // 抬头在这里补，而不是再过一遍 `subjectLessonsText`：整节一份抬头，且不能再
      // 对拼好的正文截第二次尾——那会砍掉排在后面的工具，而不是它们各自的后半段。
      return body === '' ? undefined : [SUBJECT_HEADING, '', body].join('\n')
    })
  })
}
