/**
 * The tool-error reflection pipeline, end to end: a genuinely failed tool result
 * is journaled, the document `/correct-errors` maintains is parsed, and the
 * lesson reaches the ASSEMBLED prompt under the section of the ability that
 * failed rather than in one global pile.
 *
 * Each half is unit-tested in its own package, and the two tests that matter are
 * not: the journal files an entry under a tool NAME, the injector routes by
 * SECTION NAME, and the whole feature only works while the name the journal
 * records is a name some section answers to. That join is what this file
 * exercises — every document below is built by reading the journal back, so a
 * drift between the two naming sides fails here instead of silently costing the
 * model its lessons.
 *
 * The last two cases cover the shape the collapsed wire needs: under PTC mode a
 * sub-call settles as `tool/ptc-dispatch` and never as a `tool/result`, so the
 * journal has to read that record to learn which tool broke — and the transport
 * itself (`run_code`, the only name a program's own failure produces) has no
 * `tool:*` section, so its lessons are redirected to the section that carries
 * its guidance.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Journal from '@deepseek-ai/dsh-tool-error-journal'
import * as ReflectionPrompt from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reflection-pipeline-'))
  tempDirs.push(dir)
  return dir
}

/** A first-party tool's own prompt section, one MCP server's, and the SDK's. */
const TOOL_SECTION = 'tool:read'
const MCP_SECTION = 'mcp:fixture'
/**
 * The PTC mode section that owns `run_code` guidance. Its text lives in
 * `packages/core/tools`; here it stands in so the redirect below has somewhere
 * to land.
 */
const SDK_SECTION = 'tools:sdk'

interface Pipeline {
  ctx: Context
  journalPath: string
  docPath: string
  /** Assemble and return the named section's text; `''` when the section is not offered. */
  sectionText(name: string): Promise<string>
  /** Every assembled section whose text carries this needle. */
  sectionsCarrying(needle: string): Promise<string[]>
}

async function pipeline(): Promise<Pipeline> {
  const dir = await tempDir()
  const journalPath = join(dir, 'tool-error-log.jsonl')
  const docPath = join(dir, 'error-reflections.md')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Journal, { path: journalPath })
  await ctx.plugin(ReflectionPrompt, { docPath })
  // The abilities a real deployment composes; each already has something to say,
  // which is also what `applyReflections` requires before it appends anything.
  ctx.systemPrompt.section({ name: TOOL_SECTION, order: 1000, text: 'Read a file from disk.' })
  ctx.systemPrompt.section({ name: MCP_SECTION, order: 1001, text: 'This session has an MCP server connected.' })
  ctx.systemPrompt.section({ name: SDK_SECTION, order: 810, text: 'Write a program against the declared bindings.' })
  return {
    ctx,
    journalPath,
    docPath,
    async sectionText(name: string): Promise<string> {
      const assembly = await ctx.systemPrompt.assemble({})
      return assembly.sections.find(section => section.name === name)?.text ?? ''
    },
    async sectionsCarrying(needle: string): Promise<string[]> {
      const assembly = await ctx.systemPrompt.assemble({})
      return assembly.sections.filter(section => section.text.includes(needle)).map(section => section.name)
    },
  }
}

/** Emit one failed tool result exactly as the agent loop commits it. */
function failCall(ctx: Context, session: Session, seq: number, callId: string, name: string, text: string): void {
  ctx.emit('session/event', session, {
    type: 'tool/call', seq: SessionSeq(seq), time: Date.now(),
    data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: '{}' },
  })
  ctx.emit('session/event', session, {
    type: 'tool/result', seq: SessionSeq(seq + 1), time: Date.now(), surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text }],
        isError: true,
      }),
    },
  })
}

/** Read the journal back once every queued append has landed. */
async function journalEntries(path: string, expected: number): Promise<Journal.ToolErrorEntry[]> {
  let entries: Journal.ToolErrorEntry[] = []
  await vi.waitFor(async () => {
    entries = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as Journal.ToolErrorEntry)
    expect(entries).toHaveLength(expected)
  }, { timeout: 5_000 })
  return entries
}

describe('the tool-error reflection pipeline', () => {
  it('routes each journaled failure to the prompt section of the ability that failed', async () => {
    const { ctx, journalPath, docPath, sectionText } = await pipeline()
    try {
      const session = Session.create(SessionId('pipeline-session'))
      failCall(ctx, session, 1, 'call-read', 'read', 'ENOENT: the file moved')
      failCall(ctx, session, 3, 'call-mcp', 'mcp__fixture__add', 'Invalid arguments for add')

      // 1. The journal names the TOOL, including the server-qualified MCP name.
      const entries = await journalEntries(journalPath, 2)
      expect(entries.map(entry => entry.name)).toEqual(['read', 'mcp__fixture__add'])
      expect(entries[0]?.text).toBe('ENOENT: the file moved')

      // 2. `/correct-errors` hands the child exactly these names and orders it to
      //    section the document by them: a first-party tool keys its own section,
      //    an MCP tool folds into its server's. Derive the document from the
      //    RECORDED names, so this test cannot assert against its own guess.
      const subjects = entries.map((entry) => {
        const server = /^mcp__([A-Za-z0-9_-]+)__/u.exec(entry.name)?.[1]
        return {
          subject: server === undefined ? `tool:${entry.name}` : `mcp:${server}`,
          lesson: `lesson for ${entry.name}`,
        }
      })
      expect(subjects).toEqual([
        { subject: TOOL_SECTION, lesson: 'lesson for read' },
        { subject: MCP_SECTION, lesson: 'lesson for mcp__fixture__add' },
      ])
      await writeFile(docPath, [
        'user-written notes stay put.',
        ...subjects.flatMap(({ subject, lesson }) => ['', `## ${subject}`, lesson]),
      ].join('\n'), 'utf8')

      // 3. Every lesson lands under its own ability, and only there.
      expect(await sectionText(TOOL_SECTION)).toContain('lesson for read')
      expect(await sectionText(MCP_SECTION)).toContain('lesson for mcp__fixture__add')
      const global = await sectionText(ReflectionPrompt.SECTION_NAME)
      expect(global).not.toContain('lesson for read')
      expect(global).not.toContain('lesson for mcp__fixture__add')
      // Content the pipeline does not own is still carried through.
      expect(global).toContain('user-written notes stay put.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a per-tool MCP subject win its own block inside the server section', async () => {
    const { ctx, docPath, sectionText } = await pipeline()
    try {
      // The injector also accepts the per-tool key, which is what the journal's
      // own subject vocabulary describes; either spelling reaches the server's
      // section, and only this one adds the `### <tool>` attribution block.
      await writeFile(docPath, [
        '## mcp:fixture',
        'the server itself wants a token',
        '',
        '## mcp__fixture__create_issue',
        'confirm the repository exists first',
      ].join('\n'), 'utf8')

      const mcp = await sectionText(MCP_SECTION)
      expect(mcp.indexOf('the server itself wants a token'))
        .toBeLessThan(mcp.indexOf('### create_issue'))
      expect(mcp).toContain('confirm the repository exists first')
      // A subject that is not the server's own tool list does not leak in.
      expect(mcp).not.toContain('### add')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops a lesson whose subject no composed section answers to', async () => {
    const { ctx, docPath, sectionText, sectionsCarrying } = await pipeline()
    try {
      // A subject is recognised by its shape, so a stale or invented key is not
      // demoted into the global pile — it is simply never injected. Any section
      // that stops being composed takes its lessons out of the prompt with it,
      // which is the intended behaviour and the reason the PTC case below is
      // silent rather than loud.
      await writeFile(docPath, [
        '## tool:read',
        'a lesson a live section receives',
        '',
        '## tool:delete_forever',
        'a lesson for a section that is not composed',
      ].join('\n'), 'utf8')

      expect(await sectionText(TOOL_SECTION)).toContain('a lesson a live section receives')
      expect(await sectionsCarrying('tool:delete_forever')).toEqual([])
      expect(await sectionText(ReflectionPrompt.SECTION_NAME)).toBe('')
      // An empty optional section is not offered at all, so a deployment with
      // nothing to say pays nothing for the feature.
      const assembly = await ctx.systemPrompt.assemble({})
      expect(assembly.sections.some(section => section.name === ReflectionPrompt.SECTION_NAME)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reaches the tool that broke when PTC mode contains the failure', async () => {
    const { ctx, journalPath, docPath, sectionText, sectionsCarrying } = await pipeline()
    try {
      const session = Session.create(SessionId('ptc-session'))
      // What the PTC bridge appends for a failed sub-call. The record carries
      // the MCP tool's own name and its failure, and it is the ONLY record of
      // this failure: the collapse keeps sub-calls off the message surface, so
      // no `tool/result` ever names them. A program that catches its own
      // failures — the recommended way to write one — leaves nothing else.
      ctx.emit('session/event', session, {
        type: 'tool/ptc-dispatch', seq: SessionSeq(1), time: Date.now(),
        data: {
          rootCallId: ToolCallId('outer'),
          parentCallId: ToolCallId('outer'),
          subCallId: ToolCallId('outer:ptc:1'),
          name: 'mcp__fixture__add',
          arguments: '{}',
          isError: true,
          content: [{ type: 'text', text: 'Invalid arguments for add' }],
        },
      })

      // The journal files it under the tool that broke, not the transport.
      const entries = await journalEntries(journalPath, 1)
      expect(entries.map(entry => entry.name)).toEqual(['mcp__fixture__add'])
      expect(entries[0]?.callId).toBe('outer:ptc:1')
      expect(entries[0]?.text).toBe('Invalid arguments for add')

      // And that name is one an ability answers to, so the lesson lands.
      await writeFile(docPath, ['## mcp:fixture', 'the lesson that now arrives'].join('\n'), 'utf8')
      expect(await sectionText(MCP_SECTION)).toContain('the lesson that now arrives')
      // Not demoted to the global pile, and not duplicated elsewhere.
      expect(await sectionsCarrying('the lesson that now arrives')).toEqual([MCP_SECTION])
      expect(await sectionText(ReflectionPrompt.SECTION_NAME)).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lands a transport lesson in the section that owns the transport guidance', async () => {
    const { ctx, journalPath, docPath, sectionText, sectionsCarrying } = await pipeline()
    try {
      const session = Session.create(SessionId('ptc-transport-session'))
      // An uncaught failure escapes into the transport call, so `run_code` is
      // the name this incident produces — and the transport owns no `tool:*`
      // section, because its guidance is the whole of `tools:sdk`.
      // A `tool:run_code` subject is shape-valid, so without the redirect it
      // would be neither global nor injectable: written once, read never.
      failCall(ctx, session, 1, 'outer', 'run_code', 'code run failed (error): boom')

      expect((await journalEntries(journalPath, 1)).map(entry => entry.name)).toEqual(['run_code'])
      expect(Journal.normalizeReflectionSubject('tool:run_code')).toBe('tool:run_code')

      await writeFile(docPath, ['## tool:run_code', 'await every binding you start'].join('\n'), 'utf8')
      expect(await sectionText(SDK_SECTION)).toContain('await every binding you start')
      expect(await sectionsCarrying('await every binding you start')).toEqual([SDK_SECTION])
      expect(await sectionText(ReflectionPrompt.SECTION_NAME)).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
