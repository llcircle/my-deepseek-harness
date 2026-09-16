/**
 * The /translate-system-prompt command: an empty assembled prompt succeeds
 * without a child; a non-empty prompt starts exactly one one-shot subagent
 * whose prompt carries the original text and the bilingual archive
 * instructions; a missing system-prompt service or subagent runtime fails
 * loudly.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as TranslateSystemPrompt from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface SubagentStub {
  runs: Array<{ provider: string; prompt: string; parent: Agent }>
}

class FakeSystemPrompt extends Service {
  constructor(
    inner: Context,
    private readonly assembly: () => Promise<PromptAssembly>,
  ) {
    super(inner, 'systemPrompt')
  }

  assemble(): Promise<PromptAssembly> {
    return this.assembly()
  }
}

async function harness(options: {
  sections?: Array<{ name: string; text: string }>
  assembleError?: Error
  withSystemPrompt?: boolean
  withSubagents?: boolean
}): Promise<{ ctx: Context; agent: Agent; subagents: SubagentStub }> {
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

      start(provider: string, request: { prompt: ContentBlock[]; parent: Agent }): Promise<{ id: SessionId }> {
        subagents.runs.push({
          provider,
          prompt: request.prompt.map(block => block.type === 'text' ? block.text : '').join('\n'),
          parent: request.parent,
        })
        return Promise.resolve({ id: SessionId('prompt-translation-child') })
      }
    }
    await ctx.plugin(FakeSubagents, {})
  }
  if (options.withSystemPrompt !== false) {
    class StubSystemPrompt extends FakeSystemPrompt {
      constructor(inner: Context) {
        super(inner, () => {
          if (options.assembleError !== undefined) return Promise.reject(options.assembleError)
          return Promise.resolve({
            sections: options.sections ?? [],
            contexts: [],
            tools: [],
            variables: {},
          })
        })
      }
    }
    await ctx.plugin(StubSystemPrompt, {})
  }
  await ctx.plugin(TranslateSystemPrompt)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-translate-'))
  tempDirs.push(dir)
  const session = ctx.sessions.create(SessionId('prompt-translate-agent'), { meta: { cwd: dir } })
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
  ctx.agents.register(agent)
  return { ctx, agent, subagents }
}

describe('the /translate-system-prompt command', () => {
  it('reports an empty assembled prompt without starting a child', async () => {
    const { ctx, agent, subagents } = await harness({})

    const settled = await ctx.commands.execute(agent, '/translate-system-prompt', [], new AbortController().signal)

    expect(settled.result).toEqual({ kind: 'success', text: 'The assembled system prompt is empty; nothing to translate.' })
    expect(subagents.runs).toHaveLength(0)
  })

  it('starts one child whose prompt carries the rendered prompt and archive instructions', async () => {
    const { ctx, agent, subagents } = await harness({
      sections: [{ name: 'deployment:persona', text: 'You are a docs harness assistant. Deploy carefully.' }],
    })

    const settled = await ctx.commands.execute(agent, '/translate-system-prompt', [], new AbortController().signal)

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs).toHaveLength(1)
    expect(subagents.runs[0]?.provider).toBe('spawn')
    expect(subagents.runs[0]?.parent).toBe(agent)
    expect(subagents.runs[0]?.prompt).toContain('You are a docs harness assistant. Deploy carefully.')
    expect(subagents.runs[0]?.prompt).toContain('## Original')
    expect(subagents.runs[0]?.prompt).toContain('## zh')
    expect(subagents.runs[0]?.prompt).toContain('system-prompt.zh.md')
    expect(subagents.runs[0]?.prompt).toContain('system-prompt.zh.prompt.md')
    expect(subagents.runs[0]?.prompt).toContain('File 2')
  })

  it('reports an assembly failure instead of starting a child', async () => {
    const { ctx, agent, subagents } = await harness({ assembleError: new Error('waterfall exploded') })

    const settled = await ctx.commands.execute(agent, '/translate-system-prompt', [], new AbortController().signal)

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('could not assemble the system prompt')
    expect(subagents.runs).toHaveLength(0)
  })

  it('fails loudly when no system-prompt service is mounted', async () => {
    const { ctx, agent, subagents } = await harness({ withSystemPrompt: false })

    const settled = await ctx.commands.execute(agent, '/translate-system-prompt', [], new AbortController().signal)

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('system-prompt service')
    expect(subagents.runs).toHaveLength(0)
  })

  it('fails loudly when no subagent runtime is mounted', async () => {
    const { ctx, agent, subagents } = await harness({
      sections: [{ name: 'deployment:persona', text: 'You are a docs harness assistant.' }],
      withSubagents: false,
    })

    const settled = await ctx.commands.execute(agent, '/translate-system-prompt', [], new AbortController().signal)

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('subagent runtime')
    expect(subagents.runs).toHaveLength(0)
  })
})
