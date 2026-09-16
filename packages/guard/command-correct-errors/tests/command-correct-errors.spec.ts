/**
 * The /correct-errors command: no journal or empty journal succeeds without a
 * child; recorded errors start exactly one one-shot subagent carrying the
 * merged reflection prompt, then the journal content moves to the archive and
 * the journal clears; a missing subagent runtime fails loudly.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as CorrectErrors from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-correct-'))
  tempDirs.push(dir)
  return dir
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return agent
}

interface SubagentStub {
  runs: Array<{
    provider: string
    prompt: string
    parent: Agent
    allowTools?: readonly string[]
    omitSections?: readonly string[]
  }>
}

async function harness(options: {
  journalLines?: string[]
  reflectionContent?: string
  withSubagents?: boolean
  config?: CorrectErrors.Config
}): Promise<{ ctx: Context; agent: Agent; subagents: SubagentStub; journalPath: string; archivePath: string; reflectionPath: string }> {
  const dir = await tempDir()
  const journalPath = join(dir, 'errors.jsonl')
  const archivePath = join(dir, 'errors-archive.jsonl')
  const reflectionPath = join(dir, 'reflections.md')
  if (options.journalLines !== undefined) {
    await mkdir(dir, { recursive: true })
    await writeFile(journalPath, options.journalLines.join('\n') + '\n')
  }
  if (options.reflectionContent !== undefined) {
    await mkdir(dir, { recursive: true })
    await writeFile(reflectionPath, options.reflectionContent)
  }
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  const subagents: SubagentStub = { runs: [] }
  if (options.withSubagents !== false) {
    class FakeSubagents extends Service {
      constructor(inner: Context) {
        super(inner, 'subagents')
      }

      start(provider: string, request: {
        prompt: ContentBlock[]
        parent: Agent
        allowTools?: readonly string[]
        omitSections?: readonly string[]
      }): Promise<{ id: SessionId }> {
        subagents.runs.push({
          provider,
          prompt: request.prompt.map(block => block.type === 'text' ? block.text : '').join('\n'),
          parent: request.parent,
          ...request.allowTools === undefined ? {} : { allowTools: request.allowTools },
          ...request.omitSections === undefined ? {} : { omitSections: request.omitSections },
        })
        return Promise.resolve({ id: SessionId('child-1') })
      }
    }
    await ctx.plugin(FakeSubagents, {})
  }
  await ctx.plugin(CorrectErrors, Object.assign({ journalPath, archivePath, reflectionDocPath: reflectionPath }, options.config))
  const agent = stubAgent(ctx, 'correct-agent')
  ctx.agents.register(agent)
  return { ctx, agent, subagents, journalPath, archivePath, reflectionPath }
}

describe('the /correct-errors command', () => {
  it('reports nothing to correct when the journal is absent', async () => {
    const { ctx, agent, subagents } = await harness({})

    const settled = await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    expect(settled.result).toEqual({ kind: 'success', text: 'No tool errors recorded; nothing to correct.' })
    expect(subagents.runs).toHaveLength(0)
  })

  it('starts one background child carrying the merged reflection prompt', async () => {
    const line = JSON.stringify({
      time: '2026-09-08T00:00:00.000Z',
      sessionId: 's1',
      seq: 3,
      name: 'mcp__memorix__save',
      callId: 'call-9',
      text: 'boom',
    })
    const { ctx, agent, subagents } = await harness({
      journalLines: [line],
      reflectionContent: '## 2026-09-07\nEarlier lesson about timeouts.',
    })

    const settled = await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs).toHaveLength(1)
    expect(subagents.runs[0]?.provider).toBe('spawn')
    expect(subagents.runs[0]?.parent).toBe(agent)
    expect(subagents.runs[0]?.prompt).toContain('mcp__memorix__save')
    expect(subagents.runs[0]?.prompt).toContain('boom')
    expect(subagents.runs[0]?.prompt).toContain('Earlier lesson about timeouts.')
    expect(subagents.runs[0]?.prompt).toContain('既有经验')
    // 文档按主题分节，子代理得知道键怎么取：第一方工具 `tool:<工具名>`，而它手上
    // 的 `mcp__memorix__save` 这种公开工具名要归到 `mcp:<服务器名>`。键错了，这一节
    // 经验就再也贴不到对应能力的提示词分段上。
    expect(subagents.runs[0]?.prompt).toContain('## tool:<工具名>')
    expect(subagents.runs[0]?.prompt).toContain('## mcp:<服务器名>')
    // 老文档是按日期分节的散文。让它「原样保留」会把旧经验永久锁在全局段里，
    // 新经验却挂在能力上——同一份文档两套结构。所以提示词必须要求按内容迁移，
    // 同时明确「迁移不等于可以丢内容」。
    expect(subagents.runs[0]?.prompt).toContain('按内容把它迁到主题小节')
    expect(subagents.runs[0]?.prompt).toContain('迁移不等于可以丢内容')
  })

  it('trims the child to the tools and sections its one job needs', async () => {
    const line = JSON.stringify({
      time: '2026-09-08T00:00:00.000Z',
      sessionId: 's1',
      seq: 3,
      name: 'read',
      callId: 'call-9',
      text: 'boom',
    })
    const { ctx, agent, subagents } = await harness({ journalLines: [line] })

    await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    // 子 agent 的活是改写一份文档：所需材料都在提示词里，shell／搜索／委派／计划
    // 对它没有一处是必需的。
    expect(subagents.runs[0]?.allowTools).toEqual(['read', 'write'])
    // `deployment:error-lessons` 正是这个子 agent 要改写的文档本身；注入它等于让
    // 改写者把自己的输出当经验读。
    expect(subagents.runs[0]?.omitSections)
      .toEqual(['harness:identity', 'deployment:persona', 'deployment:error-lessons'])
  })

  it('an explicit empty list turns trimming off rather than starving the child', async () => {
    const line = JSON.stringify({
      time: '2026-09-08T00:00:00.000Z',
      sessionId: 's1',
      seq: 3,
      name: 'read',
      callId: 'call-9',
      text: 'boom',
    })
    const { ctx, agent, subagents } = await harness({
      journalLines: [line],
      config: { childTools: [], childOmitSections: [] },
    })

    await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    // 空名单字面上意味着「一个工具都不留」，而那样的子 agent 连文档都写不出去。
    // 所以它读作「别动工具集」，请求里两个字段都不出现。
    expect(subagents.runs[0]?.allowTools).toBeUndefined()
    expect(subagents.runs[0]?.omitSections).toBeUndefined()
  })

  it('archives the raw journal and clears it after the child starts', async () => {
    const line = JSON.stringify({
      time: '2026-09-08T00:00:00.000Z',
      sessionId: 's1',
      seq: 3,
      name: 'mcp__memorix__save',
      callId: 'call-9',
      text: 'boom',
    })
    const { ctx, agent, subagents, journalPath, archivePath } = await harness({ journalLines: [line] })

    const settled = await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect((settled.result as { text: string }).text).toContain('archived')
    expect(await readFile(archivePath, 'utf8')).toContain(line)
    expect(await readFile(journalPath, 'utf8')).toBe('')
    expect(subagents.runs).toHaveLength(1)
  })

  it('does not archive or clear when there is nothing to correct', async () => {
    const { ctx, agent, subagents, journalPath, archivePath } = await harness({})

    const settled = await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    expect(settled.result).toEqual({ kind: 'success', text: 'No tool errors recorded; nothing to correct.' })
    await expect(readFile(archivePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(subagents.runs).toHaveLength(0)
  })

  it('fails loudly when no subagent runtime is mounted', async () => {
    const line = JSON.stringify({
      time: '2026-09-08T00:00:00.000Z',
      sessionId: 's1',
      seq: 3,
      name: 'read',
      callId: 'call-1',
      text: 'nope',
    })
    const { ctx, agent, subagents } = await harness({ journalLines: [line], withSubagents: false })

    const settled = await ctx.commands.execute(agent, '/correct-errors', [], new AbortController().signal)

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('subagent runtime')
    expect(subagents.runs).toHaveLength(0)
  })

  it('rejects invalid configuration', () => {
    expect(() => CorrectErrors.resolveConfig({ journalPath: 'e.jsonl', maxErrors: 0 }))
      .toThrow('maxErrors must be a positive integer')
  })
})
