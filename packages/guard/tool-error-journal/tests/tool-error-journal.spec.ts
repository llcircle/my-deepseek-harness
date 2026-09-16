/**
 * The JSONL failure journal: failed `tool/result` records append bounded
 * entries; successes and unrelated events write nothing; the journal survives
 * a missing paired tool/call record.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as Journal from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-error-journal-'))
  tempDirs.push(dir)
  return join(dir, name)
}

async function mount(config: Journal.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Journal, config)
  return ctx
}

function toolResultEvent(seq: number, callId: string, text: string, isError: boolean, internalError?: { name: string; code: string }) {
  return {
    type: 'tool/result' as const,
    seq: SessionSeq(seq),
    time: Date.parse('2026-09-08T00:00:00.000Z'),
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text }],
        isError,
      }),
      ...internalError !== undefined ? { error: internalError } : {},
    },
  }
}

async function lines(path: string): Promise<Journal.ToolErrorEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    // A quiet journal creates no file at all.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  if (raw.trim() === '') return []
  return raw.trim().split('\n').map(line => JSON.parse(line) as Journal.ToolErrorEntry)
}

describe('the tool error journal', () => {
  it('appends one bounded entry per failed tool result', async () => {
    const path = await tempPath('errors.jsonl')
    const ctx = await mount({ path, maxTextChars: 10 })
    const session = Session.create(SessionId('journal-session'))

    ctx.emit('session/event', session, {
      type: 'tool/call', seq: SessionSeq(0), time: 1,
      data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'mcp__memorix__save', arguments: '{}' },
    })
    ctx.emit('session/event', session, toolResultEvent(1, 'call-1', 'boom-boom-boom', true))

    await new Promise(resolve => setTimeout(resolve, 20))
    const entries = await lines(path)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'mcp__memorix__save',
      callId: 'call-1',
      sessionId: 'journal-session',
      seq: 1,
      // The excerpt cap bounds the model-facing text.
      text: 'boom-boom-',
      time: '2026-09-08T00:00:00.000Z',
    })
  })

  it('journals internal failures and unnamed results without a paired call', async () => {
    const path = await tempPath('errors.jsonl')
    const ctx = await mount({ path })
    const session = Session.create(SessionId('journal-internal'))

    ctx.emit('session/event', session, toolResultEvent(4, 'call-2', 'tool blew up', false, { name: 'TimeoutError', code: 'TOOL_TIMEOUT' }))

    await new Promise(resolve => setTimeout(resolve, 20))
    const entries = await lines(path)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'unknown',
      callId: 'call-2',
      internalError: { name: 'TimeoutError', code: 'TOOL_TIMEOUT' },
    })
  })

  it('writes nothing for successful results or unrelated events', async () => {
    const path = await tempPath('errors.jsonl')
    const ctx = await mount({ path })
    const session = Session.create(SessionId('journal-quiet'))

    ctx.emit('session/event', session, toolResultEvent(1, 'call-ok', 'all good', false))
    ctx.emit('session/event', session, {
      type: 'turn/start', seq: SessionSeq(2), time: 2, data: { turn: 1 },
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await lines(path)).toHaveLength(0)
  })

  it('resolves a relative sink path under the harness home', () => {
    const resolved = Journal.resolveConfig({ path: 'logs/tool-errors.jsonl' })
    const slash = String.fromCharCode(92)
    expect(resolved.documents.log.endsWith(`logs${slash}tool-errors.jsonl`)
      || resolved.documents.log.endsWith('/logs/tool-errors.jsonl')).toBe(true)
    // 归档与反思跟着日志走：一个目录里放齐三份文档，搬家时不会只搬一半。
    expect(resolved.documents.archive).toContain('tool-error-log-archive.jsonl')
    expect(resolved.documents.reflections).toContain('error-reflections.md')
    expect(resolved.documents.archive.startsWith('logs') || resolved.documents.archive.includes(`logs${slash}`) || resolved.documents.archive.includes('/logs/')).toBe(true)
  })

  it('rejects invalid configuration at load', () => {
    expect(() => Journal.resolveConfig({ path: '' })).toThrow('path must be a non-empty string')
    expect(() => Journal.resolveConfig({ path: 'x.jsonl', maxTextChars: 0 })).toThrow('maxTextChars must be a positive integer')
  })
})
