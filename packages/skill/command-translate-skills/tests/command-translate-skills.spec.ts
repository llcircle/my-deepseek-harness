/**
 * The /translate-skills command: empty catalog succeeds without a child; a
 * catalogued skill starts exactly one one-shot subagent whose prompt carries
 * only the summary fields; a missing subagent runtime fails loudly.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TranslateSkills from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-translate-'))
  tempDirs.push(dir)
  return dir
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
  registerSkill?: boolean
  withSubagents?: boolean
  config?: TranslateSkills.Config
}): Promise<{ ctx: Context; agent: Agent; subagents: SubagentStub }> {
  const dir = await tempDir()
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
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
        return Promise.resolve({ id: SessionId('translate-child') })
      }
    }
    await ctx.plugin(FakeSubagents)
  }
  await ctx.plugin(TranslateSkills, options.config ?? {})
  const session = ctx.sessions.create(SessionId('translate-agent'), { meta: { cwd: dir } })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
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
  await ctx.agents.register(agent)
  if (options.registerSkill === true) {
    ctx.skills.register({
      name: 'deploy-docs',
      description: 'Build and publish the documentation site.',
      whenToUse: 'When the docs need shipping.',
      source: 'runtime',
      content: 'SECRET BODY THAT MUST NOT LEAK INTO THE PROMPT',
    })
  }
  return { ctx, agent, subagents }
}

/**
 * Run one command line and hand back its settled execution. `execute()` returns
 * `undefined` only when the line does not resolve to a registered command,
 * which every test here treats as a broken harness rather than a result.
 */
async function run(
  ctx: Context,
  agent: Agent,
  line: string,
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const settled = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (settled === undefined) throw new Error(`${line} is not registered`)
  return settled
}

describe('the /translate-skills command', () => {
  it('reports an empty catalog without starting a child', async () => {
    const { ctx, agent, subagents } = await harness({})

    const settled = await run(ctx, agent, '/translate-skills')

    expect((settled.result as { text: string }).text).toContain('No skills catalogued')
    expect(subagents.runs).toHaveLength(0)
  })

  it('starts one child whose prompt carries only the summary fields', async () => {
    const { ctx, agent, subagents } = await harness({ registerSkill: true })
    const listSpy = vi.spyOn(ctx.skills, 'list')

    const settled = await run(ctx, agent, '/translate-skills')

    expect(settled.result.kind).toBe('success')
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ scope: agent }))
    expect(subagents.runs).toHaveLength(1)
    expect(subagents.runs[0]?.provider).toBe('spawn')
    expect(subagents.runs[0]?.prompt).toContain('deploy-docs')
    expect(subagents.runs[0]?.prompt).toContain('Build and publish the documentation site.')
    expect(subagents.runs[0]?.prompt).toContain('When the docs need shipping.')
    expect(subagents.runs[0]?.prompt).toContain('.dsh/skill-translations.zh.json')
    expect(subagents.runs[0]?.prompt).toContain('Do NOT translate skill names')
    expect(subagents.runs[0]?.prompt).toContain('promptLine')
    expect(subagents.runs[0]?.prompt).toContain('archives each skill summary in both languages')
    // The skill body never enters the prompt: descriptions only.
    expect(subagents.runs[0]?.prompt).not.toContain('SECRET BODY')
  })

  it('fails loudly when no subagent runtime is mounted', async () => {
    const { ctx, agent, subagents } = await harness({ registerSkill: true, withSubagents: false })

    const settled = await run(ctx, agent, '/translate-skills')

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('subagent runtime')
    expect(subagents.runs).toHaveLength(0)
  })

  it('also targets the shared harness-home archive so one pass covers every workspace', async () => {
    const { ctx, agent, subagents } = await harness({ registerSkill: true })

    const settled = await run(ctx, agent, '/translate-skills')

    const shared = join(resolveDshHome(), 'skill-translations.zh.json')
    expect(subagents.runs[0]?.prompt).toContain(shared)
    expect((settled.result as { text: string }).text).toContain(shared)
  })

  it('trims the child to writing one JSON file and nothing else', async () => {
    const { ctx, agent, subagents } = await harness({ registerSkill: true })

    await run(ctx, agent, '/translate-skills')

    // 提示词已经把每条待译摘要列全，原文里也没有技能正文，所以这个子 agent 的
    // 全部工作就是把一份 JSON 写出去——shell、搜索、委派对它没有一处是必需的。
    expect(subagents.runs[0]?.allowTools).toEqual(['read', 'write'])
    expect(subagents.runs[0]?.omitSections)
      .toEqual(['harness:identity', 'deployment:persona-prefix', 'deployment:error-lessons'])
  })

  it('an explicit empty list turns trimming off rather than starving the child', async () => {
    const { ctx, agent, subagents } = await harness({
      registerSkill: true,
      config: { childTools: [], childOmitSections: [] },
    })

    await run(ctx, agent, '/translate-skills')

    // 空名单字面上意味着「一个工具都不留」，那样的子 agent 连存档都写不出去；
    // 所以它读作「别动工具集」，请求里两个字段都不出现。
    expect(subagents.runs[0]?.allowTools).toBeUndefined()
    expect(subagents.runs[0]?.omitSections).toBeUndefined()
  })
})

describe('resolveConfig', () => {
  it('defaults the shared archive to the harness home and lets an empty value disable it', () => {
    expect(TranslateSkills.resolveConfig({}).sharedArchivePath).toBe('skill-translations.zh.json')
    // An explicit empty string is the documented opt-out.
    expect(TranslateSkills.resolveConfig({ sharedArchivePath: '' }).sharedArchivePath).toBeUndefined()
  })
})

describe('buildTranslationPrompt', () => {
  it('omits the shared-archive instruction when no shared archive is configured', () => {
    const prompt = TranslateSkills.buildTranslationPrompt(
      [{ name: 'tdd', description: 'Test-driven development.' }],
      '.dsh/skill-translations.zh.json',
      'zh',
    )
    const text = prompt.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('.dsh/skill-translations.zh.json')
    expect(text).not.toContain('ALSO write')
  })
})
