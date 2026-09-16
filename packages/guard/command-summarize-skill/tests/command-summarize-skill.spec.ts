/**
 * The /summarize-skill command: no conversation text fails; recorded turns
 * start exactly one one-shot subagent carrying the excerpt and the skill
 * writing instructions; a missing subagent runtime fails loudly.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import * as SummarizeSkill from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

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
  turns?: Array<{ role: 'user' | 'assistant'; text: string }>
  withSubagents?: boolean
  config?: SummarizeSkill.Config
}): Promise<{ ctx: Context; agent: Agent; subagents: SubagentStub }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-summarize-'))
  tempDirs.push(dir)
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
        prompt: SummarizeSkill.Config extends never ? never : import('@deepseek-ai/dsh-llm').ContentBlock[]
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
        return Promise.resolve({ id: SessionId('summary-child') })
      }
    }
    await ctx.plugin(FakeSubagents, {})
  }
  await ctx.plugin(SummarizeSkill, options.config ?? {})
  const session = ctx.sessions.create(SessionId('summarize-agent'), { meta: { cwd: dir } })
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
  for (const turn of options.turns ?? []) {
    if (turn.role === 'user') {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: turn.text }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    } else {
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: turn.text }] }),
        stream: [],
      }, { surfaceOp: 'append' })
    }
  }
  ctx.agents.register(agent)
  return { ctx, agent, subagents }
}

describe('the /summarize-skill command', () => {
  it('fails when no conversation text exists yet', async () => {
    const { ctx, agent, subagents } = await harness({})

    const settled = await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    expect(settled.result).toEqual({ kind: 'error', text: 'summarize-skill found no conversation text to capture yet' })
    expect(subagents.runs).toHaveLength(0)
  })

  it('starts one background child carrying the excerpt and instructions', async () => {
    const { ctx, agent, subagents } = await harness({
      turns: [
        { role: 'user', text: 'How do we deploy the docs site?' },
        { role: 'assistant', text: 'Run pnpm run website:build, then copy dist to the host.' },
      ],
    })

    const settled = await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs).toHaveLength(1)
    expect(subagents.runs[0]?.provider).toBe('spawn')
    expect(subagents.runs[0]?.parent).toBe(agent)
    expect(subagents.runs[0]?.prompt).toContain('How do we deploy the docs site?')
    expect(subagents.runs[0]?.prompt).toContain('website:build')
    expect(subagents.runs[0]?.prompt).toContain('.dsh/skills')
    expect(subagents.runs[0]?.prompt).toContain('SKILL.md')
  })

  it('trims the child to writing the skill file and nothing else', async () => {
    const { ctx, agent, subagents } = await harness({
      turns: [
        { role: 'user', text: 'How do we deploy the docs site?' },
        { role: 'assistant', text: 'Run pnpm run website:build.' },
      ],
    })

    await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    // 会话记录已经在提示词里给全，子 agent 的活是把它压成一份技能文档写出去：
    // shell、搜索、委派、计划对它没有一处是必需的。
    expect(subagents.runs[0]?.allowTools).toEqual(['read', 'write'])
    expect(subagents.runs[0]?.omitSections)
      .toEqual(['harness:identity', 'deployment:persona', 'deployment:error-lessons'])
  })

  it('an explicit empty list turns trimming off rather than starving the child', async () => {
    const { ctx, agent, subagents } = await harness({
      turns: [
        { role: 'user', text: 'How do we deploy the docs site?' },
        { role: 'assistant', text: 'Run pnpm run website:build.' },
      ],
      config: { childTools: [], childOmitSections: [] },
    })

    await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    // 空名单字面上意味着「一个工具都不留」，那样的子 agent 写不出技能文件；
    // 所以它读作「别动工具集」，请求里两个字段都不出现。
    expect(subagents.runs[0]?.allowTools).toBeUndefined()
    expect(subagents.runs[0]?.omitSections).toBeUndefined()
  })

  it('hands the whole main-line conversation to the child by default', async () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${i + 1}`,
    }))
    const { ctx, agent, subagents } = await harness({ turns })

    const settled = await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    // Past the former 20-turn default: the child still sees every turn.
    expect(subagents.runs[0]?.prompt).toContain('turn 1')
    expect(subagents.runs[0]?.prompt).toContain('turn 13')
    expect(subagents.runs[0]?.prompt).toContain('turn 25')
  })

  it('caps the handed-over turns when maxTurns is configured', async () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${i + 1}`,
    }))
    const { ctx, agent, subagents } = await harness({ turns, config: { maxTurns: 2 } })

    const settled = await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs[0]?.prompt).not.toContain('turn 1')
    expect(subagents.runs[0]?.prompt).not.toContain('turn 3')
    expect(subagents.runs[0]?.prompt).toContain('turn 4')
    expect(subagents.runs[0]?.prompt).toContain('turn 5')
  })

  it('hands the selected turn range with user guidance to the child', async () => {
    const turns = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${i + 1}`,
    }))
    const { ctx, agent, subagents } = await harness({ turns })

    const settled = await ctx.commands.execute(agent, '/summarize-skill 2-3 部署流程的完整步骤', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs).toHaveLength(1)
    expect(subagents.runs[0]?.prompt).toContain('turn 2')
    expect(subagents.runs[0]?.prompt).toContain('turn 3')
    expect(subagents.runs[0]?.prompt).not.toContain('turn 1')
    expect(subagents.runs[0]?.prompt).not.toContain('turn 4')
    expect(subagents.runs[0]?.prompt).toContain('User guidance: 部署流程的完整步骤')
    expect(subagents.runs[0]?.prompt).toContain('do not second-guess it')
  })

  it('keeps only the newest N turns with a bare count and follows the guidance', async () => {
    const turns = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${i + 1}`,
    }))
    const { ctx, agent, subagents } = await harness({ turns })

    const settled = await ctx.commands.execute(agent, '/summarize-skill 2 只总结构建命令', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs[0]?.prompt).toContain('turn 3')
    expect(subagents.runs[0]?.prompt).toContain('turn 4')
    expect(subagents.runs[0]?.prompt).not.toContain('turn 1')
    expect(subagents.runs[0]?.prompt).toContain('User guidance: 只总结构建命令')
  })

  it('fails loudly on an out-of-range or malformed selection', async () => {
    const { ctx, agent, subagents } = await harness({ turns: [{ role: 'user', text: 'hello' }] })

    const outOfRange = await ctx.commands.execute(agent, '/summarize-skill 5-9', [], new AbortController().signal)
    expect(outOfRange.result).toMatchObject({ kind: 'error' })
    expect((outOfRange.result as { text: string }).text).toContain('exceeds the 1 conversation turns')

    const malformed = await ctx.commands.execute(agent, '/summarize-skill 9-3', [], new AbortController().signal)
    expect(malformed.result).toMatchObject({ kind: 'error' })
    expect((malformed.result as { text: string }).text).toContain('range end 3 must be >= start 9')
    expect(subagents.runs).toHaveLength(0)
  })

  it('parses command input selectors and guidance', () => {
    expect(SummarizeSkill.parseSummaryInput('')).toEqual({})
    expect(SummarizeSkill.parseSummaryInput('3')).toEqual({ last: 3, guidance: undefined })
    expect(SummarizeSkill.parseSummaryInput('2-4 deploy docs')).toEqual({ from: 2, to: 4, guidance: 'deploy docs' })
    expect(SummarizeSkill.parseSummaryInput('总结部署经验')).toEqual({ guidance: '总结部署经验' })
    expect(() => SummarizeSkill.parseSummaryInput('0')).toThrow('turn count must be >= 1')
    expect(() => SummarizeSkill.parseSummaryInput('4-2')).toThrow('range end 2 must be >= start 4')
  })

  it('fails loudly when no subagent runtime is mounted', async () => {
    const { ctx, agent, subagents } = await harness({ turns: [{ role: 'user', text: 'hello' }], withSubagents: false })

    const settled = await ctx.commands.execute(agent, '/summarize-skill', [], new AbortController().signal)

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('subagent runtime')
    expect(subagents.runs).toHaveLength(0)
  })

  it('rejects invalid configuration', () => {
    expect(() => SummarizeSkill.resolveConfig({ maxTurns: 0 })).toThrow('maxTurns must be a positive integer')
  })
})
