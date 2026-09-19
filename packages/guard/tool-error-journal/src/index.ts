/**
 * Failed-tool-call journal: persists every model-facing tool failure — core
 * tools and MCP tools alike, because both surface as `tool/result` records —
 * to one JSONL file for later inspection and AI-assisted correction.
 *
 * The plugin listens on the post-commit `session/event` feed, selects
 * `tool/result` events whose message carries `isError` or whose envelope
 * names an internal failure, and appends one bounded JSON line per failure.
 * Writes run one at a time on a serialized queue; a failed append is logged
 * and contained so the session feed never notices the sink.
 *
 * The journal is only the ledger. The lessons derived from it are owned
 * elsewhere: `/correct-errors` fuses it into the reflection document, and
 * `@deepseek-ai/dsh-error-reflection-prompt` injects that document. This
 * plugin therefore registers no prompt section of its own — a second
 * registration of the same name throws.
 *
 * The reflection document is sectioned by subject: `## tool:read`,
 * `## mcp:github`, `## mcp__github__search`, `## computer:policy`.
 * `./reflections.ts` owns that split, and `./documents.ts` owns the paths of the
 * three documents.
 *
 * @module @deepseek-ai/dsh-tool-error-journal
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  resolveToolErrorDocuments,
  type ToolErrorDocumentPaths,
  type ToolErrorEntry,
} from './documents.ts'

export * from './documents.ts'
export * from './reflections.ts'

export const name = 'tool-error-journal'

/** Default per-entry cap for the model-facing failure text. */
const DEFAULT_MAX_TEXT_CHARS = 4000

/** Plugin configuration. */
export interface Config {
  /**
   * JSONL sink path. A relative path resolves under the Harness home
   * (`$DSH_HOME` or `~/.dsh`); the default file is `tool-error-log.jsonl`
   * there. The archive and the reflection document sit beside it.
   */
  path?: string
  /** Cap on the model-facing failure text excerpt stored per entry. */
  maxTextChars?: number
}

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  path: z.string(),
  maxTextChars: z.number().step(1).min(1).default(DEFAULT_MAX_TEXT_CHARS),
})

/**
 * Resolve and validate configuration; misconfiguration fails at load.
 * @param config - untrusted plugin configuration.
 * @param env - environment mapping used to resolve the Harness home.
 * @returns the resolved documents and the per-entry text cap.
 * @throws when `path` is empty or `maxTextChars` is not a positive integer.
 */
export function resolveConfig(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): { documents: ToolErrorDocumentPaths; maxTextChars: number } {
  const maxTextChars = config.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  if (!Number.isInteger(maxTextChars) || maxTextChars < 1) {
    throw new Error('tool-error-journal: maxTextChars must be a positive integer')
  }
  const declared = config.path ?? 'tool-error-log.jsonl'
  if (declared.trim() === '') {
    throw new Error('tool-error-journal: path must be a non-empty string')
  }
  const log = isAbsolute(declared) ? resolve(declared) : join(resolveDshHome(undefined, env), declared)
  return {
    documents: resolveToolErrorDocuments(dirname(log), { log: basename(log) }),
    maxTextChars,
  }
}

/** Register the `session/event` tap that feeds the journal. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const { documents } = resolved
  // Per-session call-id to tool-name memory from the paired tool/call record.
  const names = new WeakMap<Session, Map<string, string>>()
  let ensuredDir: Promise<void> | undefined
  let tail: Promise<void> = Promise.resolve()

  const append = (entry: ToolErrorEntry): void => {
    tail = tail.then(async () => {
      ensuredDir ??= mkdir(dirname(documents.log), { recursive: true }).then(() => {})
      await ensuredDir
      await appendFile(documents.log, JSON.stringify(entry) + '\n', 'utf8')
    }).catch((error: unknown) => {
      // The journal must never break the session feed it observes; a failed
      // append is a lost entry, reported to the operator log.
      ctx.logger.warn('tool-error-journal: failed to append an error entry: %o', error)
    })
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'tool/call') {
      const map = names.get(session) ?? new Map<string, string>()
      map.set(event.data.callId, event.data.name)
      names.set(session, map)
      return
    }
    if (event.type !== 'tool/result') return
    const data = event.data
    // ToolResultMessage.content is a single-element tuple: the one tool-result block.
    const inner = data.message.content[0]
    // The model-facing failure flag rides the tool-result content block; the
    // envelope's error names an internal failure identity when one exists.
    const failed = inner.isError === true || data.error !== undefined
    if (!failed) return
    const callId = inner.toolCallId
    const text = inner.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .slice(0, resolved.maxTextChars)
    const internalError = data.error
    append({
      time: new Date(event.time).toISOString(),
      sessionId: session.id,
      seq: event.seq,
      name: names.get(session)?.get(callId) ?? 'unknown',
      callId,
      ...internalError !== undefined ? { internalError } : {},
      text,
    })
    // One result consumes one call identity: the map cannot grow without bound.
    names.get(session)?.delete(callId)
  })

  ctx.effect(() => async () => {
    // A pending append still lands: disposal waits for the serialized tail.
    await tail
  }, 'tool-error-journal: drain the append queue')
}
