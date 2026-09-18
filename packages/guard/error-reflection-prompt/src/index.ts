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
 * Whatever is left over — prose before the first heading, legacy `## YYYY-MM-DD`
 * blocks, hand-written notes with a title that names no subject — still lands in
 * the `deployment:error-lessons` section, capped, exactly as before. Upgrading
 * the document format must not silently drop lessons already on disk.
 *
 * The document is re-read on every assembly (cached by mtime/size so one
 * assembly costs one read), so an agent picks up the latest pass without a
 * restart. An absent or empty document contributes nothing at all.
 *
 * @module @deepseek-ai/dsh-error-reflection-prompt
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
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

/** Cut the capped tail on a `## ` heading boundary when possible. */
function tailFromHeadingBoundary(trimmed: string, maxChars: number): string {
  if (trimmed.length <= maxChars) return trimmed
  const cut = trimmed.slice(-maxChars)
  const boundary = cut.indexOf('\n## ')
  return boundary === -1 ? cut : cut.slice(boundary + 1)
}

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
 * The appended text for ONE subject's lessons; empty when that subject has none.
 * @param raw - that subject's own lessons.
 * @param maxSubjectChars - tail cap, applied on a `## ` boundary when one exists.
 * @returns the headed text, or `''` when the subject has no lessons.
 */
export function subjectLessonsText(raw: string, maxSubjectChars: number): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return [
    '以下是这项能力过往失败的教训（自动生成）：',
    '',
    tailFromHeadingBoundary(trimmed, maxSubjectChars),
  ].join('\n')
}

/**
 * Read and parse the reflection document, reusing the last parse while the file
 * is unchanged. Assembly asks once for the global text and once per section for
 * that section's lessons, so without this cache one assembly would re-read the
 * file dozens of times.
 * @param path - absolute document path.
 * @returns the parsed document; an absent file parses as empty.
 */
function reader(path: string): () => ReflectionDocument {
  let cached: { key: string; document: ReflectionDocument } | undefined
  return () => {
    let key = 'absent'
    try {
      const stats = statSync(path)
      key = `${stats.mtimeMs}:${stats.size}`
    } catch (error) {
      // A missing document means no lessons exist yet; other failures propagate.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      return { global: '', subjects: new Map() }
    }
    if (cached?.key === key) return cached.document
    const document = parseReflectionDocument(readFileSync(path, 'utf8'))
    cached = { key, document }
    return document
  }
}

/** Register the lessons section and the per-subject reflection source. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const read = reader(resolved.docPath)
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: SECTION_NAME,
      order: promptCtx.systemPrompt.getSectionOrder('ERROR_LESSONS'),
      text: () => lessonsSectionText(read().global, resolved.maxPromptChars),
    })
    promptCtx.systemPrompt.reflectionSource((sectionName) => {
      const lessons = read().subjects.get(sectionName)
      return lessons === undefined ? undefined : subjectLessonsText(lessons, resolved.maxSubjectChars)
    })
  })
}
