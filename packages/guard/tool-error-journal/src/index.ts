/**
 * Failed-tool-call journal: persists every model-facing tool failure — core
 * tools, MCP tools, and PTC mode sub-calls alike — to one JSONL file for later
 * inspection and AI-assisted correction.
 *
 * The plugin listens on the post-commit `session/event` feed and selects two
 * shapes of failure. A native call settles as a `tool/result` whose message
 * carries `isError` or whose envelope names an internal failure. A PTC mode
 * sub-call settles as `tool/ptc-dispatch` instead — the collapse deliberately
 * keeps sub-calls off the message surface, so no `tool/result` ever names them
 * — and is selected by the same `isError`/`error` test. Both append one bounded
 * JSON line per failure under the name of the tool that actually failed.
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
// Type-only: pulls the `tool/ptc-dispatch` session-event declaration this file
// taps, and the type of the content blocks that record carries.
import type { PtcDispatchEventData } from '@deepseek-ai/dsh-tools/types'
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

/**
 * The model-facing text of one recorded failure, capped for the entry.
 *
 * Both failure shapes reach this with the same block vocabulary — a
 * `tool/ptc-dispatch` record is documented to carry a sub-call's outcome "in
 * `tool/result`'s own vocabulary" — so one reader serves both.
 *
 * @param content - the failure's content blocks.
 * @param maxTextChars - cap on the stored excerpt.
 * @returns the joined text blocks, truncated.
 */
function failureText(content: PtcDispatchEventData['content'], maxTextChars: number): string {
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .slice(0, maxTextChars)
}

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
    // A PTC mode sub-call settles as this log-only record, never as a
    // `tool/result`: keeping sub-calls off the message surface is the whole
    // point of the collapse, so a program that catches its own failures — the
    // RECOMMENDED way to write one — used to leave the journal with nothing at
    // all, and an uncaught one filed the failure under `run_code` instead of
    // the tool that broke. The record already carries the real tool name and
    // the sub-call id, so no `tool/call` pairing is needed here.
    if (event.type === 'tool/ptc-dispatch') {
      const data = event.data
      if (!data.isError && data.error === undefined) return
      append({
        time: new Date(event.time).toISOString(),
        sessionId: session.id,
        seq: event.seq,
        name: data.name,
        callId: data.subCallId,
        ...data.error === undefined
          ? {}
          : { internalError: { name: data.error.name, code: data.error.code } },
        text: failureText(data.content, resolved.maxTextChars),
      })
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
    const internalError = data.error
    append({
      time: new Date(event.time).toISOString(),
      sessionId: session.id,
      seq: event.seq,
      name: names.get(session)?.get(callId) ?? 'unknown',
      callId,
      ...internalError !== undefined ? { internalError } : {},
      text: failureText(inner.content, resolved.maxTextChars),
    })
    // One result consumes one call identity: the map cannot grow without bound.
    names.get(session)?.delete(callId)
  })

  ctx.effect(() => async () => {
    // A pending append still lands: disposal waits for the serialized tail.
    await tail
  }, 'tool-error-journal: drain the append queue')
}
