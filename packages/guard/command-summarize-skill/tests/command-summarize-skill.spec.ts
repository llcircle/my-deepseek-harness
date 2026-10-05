/**
 * Learning from a session's own work.
 *
 * The `/summarize-skill` command: no conversation text fails; recorded turns
 * start exactly one one-shot subagent carrying the excerpt and the skill
 * writing instructions; a missing subagent runtime fails loudly.
 *
 * The compaction pass: a successful compaction starts ONE curation child
 * carrying the summary plus the skills this deployment owns — in full when the
 * ranking picks them, by name and path otherwise — while a failed compaction, a
 * subagent's own compaction, an unregistered calling agent, an incomplete
 * catalog, a pass already in flight, and `autoCurate: false` all leave the
 * corpus alone.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SkillRegistry, { type SkillSummary } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as SummarizeSkill from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** One skill file the harness writes before the plugin is mounted. */
interface SkillFixture {
  readonly name: string
  readonly description: string
  readonly body: string
}

/** One recorded `subagents.start()` call. */
interface StartedChild {
  readonly provider: string
  readonly prompt: string
  readonly parent: Agent
  readonly allowTools?: readonly string[]
  readonly omitSections?: readonly string[]
  readonly signal: AbortSignal
}

/** A subagent service stub whose children settle only when the test says so. */
interface SubagentStub {
  readonly runs: StartedChild[]
  /** Indices the drain has disposed, in order. */
  readonly disposals: number[]
  readonly plugin: new (inner: Context) => Service
  /** Settle the oldest unsettled child, resolving or rejecting its result. */
  settle(mode?: 'ok' | 'fail'): void
  /** Make every later `dispose()` reject. */
  failDispose(): void
  /** Make every later `start()` reject with an infrastructure fault. */
  failStart(): void
}

/**
 * Build the stub. `start` publishes a run immediately — like the real seam —
 * but its `result` stays open until {@link SubagentStub.settle}, which is what
 * lets a test hold one child in flight across a second compaction.
 * @returns the recorded runs, the disposal log, the Service class to mount, and the two failure switches.
 */
function makeSubagents(): SubagentStub {
  const runs: StartedChild[] = []
  const disposals: number[] = []
  const settlers: Array<(mode: 'ok' | 'fail') => void> = []
  let disposeFails = false
  let startFails = false

  const plugin = class FakeSubagents extends Service {
    constructor(inner: Context) {
      super(inner, 'subagents')
    }

    start(provider: string, request: {
      prompt: readonly { type: string; text?: string }[]
      parent: Agent
      signal: AbortSignal
      allowTools?: readonly string[]
      omitSections?: readonly string[]
    }): Promise<SubagentRun> {
      if (startFails) return Promise.reject(new Error('provider refused to spawn'))
      const index = runs.length
      runs.push({
        provider,
        prompt: request.prompt.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n'),
        parent: request.parent,
        signal: request.signal,
        ...request.allowTools === undefined ? {} : { allowTools: request.allowTools },
        ...request.omitSections === undefined ? {} : { omitSections: request.omitSections },
      })
      const result = new Promise<never>((resolve, reject) => {
        settlers.push(mode => mode === 'ok'
          ? resolve(undefined as never)
          : reject(new Error('child failed')))
      })
      return Promise.resolve({
        id: SessionId(`child-${index + 1}`),
        localAgent: undefined,
        result,
        dispose: () => {
          disposals.push(index)
          return disposeFails ? Promise.reject(new Error('dispose refused')) : Promise.resolve()
        },
      } as unknown as SubagentRun)
    }
  }

  return {
    runs,
    disposals,
    plugin,
    settle(mode = 'ok') {
      const next = settlers.shift()
      if (next === undefined) throw new Error('no child is waiting to settle')
      next(mode)
    },
    failDispose() { disposeFails = true },
    failStart() { startFails = true },
  }
}

async function harness(options: {
  turns?: Array<{ role: 'user' | 'assistant'; text: string }>
  withSubagents?: boolean
  skills?: SkillFixture[]
  customSkills?: SkillFixture[]
  registerAgent?: boolean
  /** Omit the session's working directory. */
  withoutCwd?: boolean
  sessionMeta?: { origin?: 'subagent'; delegationDepth?: number }
  config?: SummarizeSkill.Config
}): Promise<{
  ctx: Context
  fiber: { dispose(): Promise<void> }
  agent: Agent
  session: Session
  subagents: SubagentStub
  workspace: string
  skillsHome: string
}> {
  const dir = await tempDir('summarize')
  const home = join(dir, '.dsh')
  const workspace = join(dir, 'workspace')
  await mkdir(workspace, { recursive: true })
  const customRoot = join(dir, 'shared-skills')
  if (options.skills !== undefined) await writeSkills(join(home, 'skills'), options.skills)
  if (options.customSkills !== undefined) await writeSkills(customRoot, options.customSkills)
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: home,
    agentsHome: join(dir, '.agents'),
    customSkillDirs: options.customSkills === undefined ? [] : [customRoot],
    watch: false,
  })
  const subagents = makeSubagents()
  if (options.withSubagents !== false) await ctx.plugin(subagents.plugin)
  const fiber = await ctx.plugin(SummarizeSkill, options.config ?? {})
  const session = ctx.sessions.create(SessionId('summarize-agent'), {
    meta: {
      ...options.withoutCwd === true ? {} : { cwd: workspace },
      ...options.sessionMeta ?? {},
    },
  })
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
        message: createAssistantMessage({
          content: [{ type: 'text', text: turn.text }],
          source: { provider: 'mock', model: 'mock' },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
    }
  }
  if (options.registerAgent !== false) await ctx.agents.register(agent)
  return { ctx, fiber, agent, session, subagents, workspace, skillsHome: join(home, 'skills') }
}

async function writeSkills(root: string, skills: readonly SkillFixture[]): Promise<void> {
  for (const skill of skills) {
    const dir = join(root, skill.name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`,
    )
  }
}

/**
 * Append one successful compaction lifecycle for `session`.
 *
 * Both events go through `append`, so the plugin's listener sees exactly what a
 * real backend publishes — including the summary it pairs with the boundary.
 * @param session - the session to record the lifecycle on.
 * @param summaryText - the summary text the curation child must receive.
 * @param compactionId - unique id for this lifecycle.
 */
function compact(session: Session, summaryText: string, compactionId = 'test-compaction'): void {
  const id = CompactionId(compactionId)
  session.append('compaction/summary', {
    compactionId: id,
    summary: [{ type: 'text', text: summaryText }],
    shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
    shadowedSeqs: [],
    shadowedTokenCount: 0,
    provider: 'mock',
    model: 'mock',
    rawOutput: [],
  })
  session.append('compaction/end', { compactionId: id, turn: null })
}

/** Append one FAILED compaction lifecycle for `session`. */
function compactFailing(session: Session, compactionId = 'failed-compaction'): void {
  const id = CompactionId(compactionId)
  session.append('compaction/summary', {
    compactionId: id,
    summary: [{ type: 'text', text: 'half a summary' }],
    shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
    shadowedSeqs: [],
    shadowedTokenCount: 0,
    provider: 'mock',
    model: 'mock',
    rawOutput: [],
  })
  session.append('compaction/end', { compactionId: id, turn: null, error: 'provider failed' })
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

/** Wait until `count` curation children have been published. */
async function waitForChild(subagents: SubagentStub, count = 1): Promise<void> {
  await vi.waitFor(() => { expect(subagents.runs).toHaveLength(count) })
}

/** Give a pass that must NOT start a child its chance to (not) do so. */
async function settleNothing(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('the /summarize-skill command', () => {
  it('fails when no conversation text exists yet', async () => {
    const { ctx, agent, subagents } = await harness({})

    const settled = await run(ctx, agent, '/summarize-skill')

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

    const settled = await run(ctx, agent, '/summarize-skill')

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

    await run(ctx, agent, '/summarize-skill')

    // 会话记录已经在提示词里给全，子 agent 的活是把它压成一份技能文档写出去：
    // shell、搜索、委派、计划对它没有一处是必需的。
    expect(subagents.runs[0]?.allowTools).toEqual(['read', 'write'])
    expect(subagents.runs[0]?.omitSections)
      .toEqual(['harness:identity', 'deployment:persona-prefix', 'deployment:error-lessons'])
  })

  it('an explicit empty list turns trimming off rather than starving the child', async () => {
    const { ctx, agent, subagents } = await harness({
      turns: [
        { role: 'user', text: 'How do we deploy the docs site?' },
        { role: 'assistant', text: 'Run pnpm run website:build.' },
      ],
      config: { childTools: [], childOmitSections: [] },
    })

    await run(ctx, agent, '/summarize-skill')

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

    const settled = await run(ctx, agent, '/summarize-skill')

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

    const settled = await run(ctx, agent, '/summarize-skill')

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

    const settled = await run(ctx, agent, '/summarize-skill 2-3 部署流程的完整步骤')

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

    const settled = await run(ctx, agent, '/summarize-skill 2 只总结构建命令')

    expect(settled.result.kind).toBe('success')
    expect(subagents.runs[0]?.prompt).toContain('turn 3')
    expect(subagents.runs[0]?.prompt).toContain('turn 4')
    expect(subagents.runs[0]?.prompt).not.toContain('turn 1')
    expect(subagents.runs[0]?.prompt).toContain('User guidance: 只总结构建命令')
  })

  it('fails loudly on an out-of-range or malformed selection', async () => {
    const { ctx, agent, subagents } = await harness({ turns: [{ role: 'user', text: 'hello' }] })

    const outOfRange = await run(ctx, agent, '/summarize-skill 5-9')
    expect(outOfRange.result).toMatchObject({ kind: 'error' })
    expect((outOfRange.result as { text: string }).text).toContain('exceeds the 1 conversation turns')

    const malformed = await run(ctx, agent, '/summarize-skill 9-3')
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
    expect(() => SummarizeSkill.parseSummaryInput('0-3')).toThrow('range start must be >= 1')
    expect(() => SummarizeSkill.parseSummaryInput('4-2')).toThrow('range end 2 must be >= start 4')
  })

  it('renders a caught value as one line, whether or not it is an Error', () => {
    // Both catch sites in the handler funnel through this, so the non-Error arm
    // only ever runs for a hook that threw a bare string — it still has to hold.
    expect(SummarizeSkill.failureText(new Error('boom'))).toBe('boom')
    expect(SummarizeSkill.failureText('raw throw')).toBe('raw throw')
  })

  it('resolves every default when the config object is bare', () => {
    // schemastery fills these in for a plugin-loaded row, but `resolveConfig` is
    // the public entry the tests and CLI call, so its own defaults must hold too.
    expect(SummarizeSkill.resolveConfig({})).toEqual({
      skillsDir: '.dsh/skills',
      maxTurns: undefined,
      provider: 'spawn',
      childTools: ['read', 'write'],
      childOmitSections: ['harness:identity', 'deployment:persona-prefix', 'deployment:error-lessons'],
      autoCurate: true,
      curateMaxTargets: 3,
      curateMaxListedSkills: 30,
    })
  })

  it('reads only direct user and completed assistant text turns', () => {
    const session = Session.create(SessionId('turn-probe'), [], {
      version: SESSION_FORMAT_VERSION, id: SessionId('turn-probe'), createdAt: 0, isSeeded: false,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'what changed?' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // 空正文的一轮（只有附件、只有工具调用）不是可以总结的一轮。
    session.append('user/message', createUserMessage({
      content: [],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // 注入上下文不是人说的话：它不能冒充一轮对话被总结。
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'plugin', plugin: 'probe' },
    }), { surfaceOp: 'append' })
    // 没有正文的轮次（只有工具调用）没有可捕获的内容。
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'the cache prefix changed' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      stream: [],
      interrupted: true,
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 3,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'and the list moved to the step' }],
        source: { provider: 'mock', model: 'mock' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })

    const turns = SummarizeSkill.recentTurns(session.snapshotEvents())

    expect(turns).toEqual([
      { role: 'user', text: 'what changed?' },
      { role: 'assistant', text: 'and the list moved to the step' },
    ])
    expect(SummarizeSkill.recentTurns(session.snapshotEvents(), 1)).toEqual([
      { role: 'assistant', text: 'and the list moved to the step' },
    ])
  })

  it('fails loudly when no subagent runtime is mounted', async () => {
    const { ctx, agent, subagents } = await harness({ turns: [{ role: 'user', text: 'hello' }], withSubagents: false })

    const settled = await run(ctx, agent, '/summarize-skill')

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('subagent runtime')
    expect(subagents.runs).toHaveLength(0)
  })

  it('fails loudly when the session carries no working directory', async () => {
    const { ctx, agent, subagents } = await harness({
      turns: [{ role: 'user', text: 'hello' }],
      withoutCwd: true,
    })

    const settled = await run(ctx, agent, '/summarize-skill')

    // 技能目录是相对工作区解析的：没有工作区就写不出文件，宁可当场说清楚。
    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('requires a session with a working directory')
    expect(subagents.runs).toHaveLength(0)
  })

  it('reports an absolute skills dir unchanged', async () => {
    const { ctx, agent } = await harness({
      turns: [{ role: 'user', text: 'capture this' }],
      config: { skillsDir: '/srv/skills' },
    })

    const settled = await run(ctx, agent, '/summarize-skill')

    // 绝对路径不再拼到工作区上：那是部署在指定一个确切的位置。
    expect(settled.result.kind).toBe('success')
    expect((settled.result as { text: string }).text).toContain('it will write the skill under /srv/skills.')
  })

  it('reports a start failure instead of a phantom success', async () => {
    const { ctx, agent, subagents } = await harness({ turns: [{ role: 'user', text: 'hello' }] })
    subagents.failStart()

    const settled = await run(ctx, agent, '/summarize-skill')

    expect(settled.result).toMatchObject({ kind: 'error' })
    expect((settled.result as { text: string }).text).toContain('could not start the summary child')
  })

  it('rejects invalid configuration', () => {
    expect(() => SummarizeSkill.resolveConfig({ maxTurns: 0 })).toThrow('maxTurns must be a positive integer')
    expect(() => SummarizeSkill.resolveConfig({ curateMaxTargets: 0 })).toThrow('curateMaxTargets must be a positive integer')
    expect(() => SummarizeSkill.resolveConfig({ curateMaxListedSkills: 0 })).toThrow('curateMaxListedSkills must be a positive integer')
  })
})

describe('the compaction curation pass', () => {
  const DEPLOY_SKILL: SkillFixture = {
    name: 'deploy-docs',
    description: 'Deploy the documentation site to the host.',
    body: 'Run pnpm run website:build, then copy dist to the host.',
  }

  it('starts one curation child carrying the summary and the owned corpus', async () => {
    const { session, subagents, skillsHome } = await harness({ skills: [DEPLOY_SKILL] })

    compact(session, 'The session rebuilt the docs site and copied dist to the host.')
    await waitForChild(subagents)

    const child = subagents.runs[0]!
    expect(child.provider).toBe('spawn')
    // 子 agent 的活是改写技能文件，工具集与显式命令那条路径一致。
    expect(child.allowTools).toEqual(['read', 'write'])
    expect(child.prompt).toContain('The session rebuilt the docs site and copied dist to the host.')
    expect(child.prompt).toContain('- `deploy-docs`: Deploy the documentation site to the host.')
    expect(child.prompt).toContain(join(skillsHome, 'deploy-docs', 'SKILL.md'))
    expect(child.prompt).toContain('Run pnpm run website:build, then copy dist to the host.')
    expect(child.prompt).toContain('1. CREATE')
    expect(child.prompt).toContain('2. REFLECT')
    expect(child.prompt).toContain('nothing to save')
  })

  it('lists every owned skill but prints only the ranked ones in full', async () => {
    const { session, subagents } = await harness({
      skills: [
        { name: 'pdf-report', description: 'Render a PDF report.', body: 'BODY-PDF-REPORT' },
        { name: 'pdf-merge', description: 'Merge two PDF files.', body: 'BODY-PDF-MERGE' },
        { name: 'image-crop', description: 'Crop an image.', body: 'BODY-IMAGE-CROP' },
      ],
      config: { curateMaxTargets: 1 },
    })

    compact(session, 'Rendered the quarterly pdf report and merged the appendix.')
    await waitForChild(subagents)

    const prompt = subagents.runs[0]!.prompt
    // 排名决定谁连正文一起交出去——那是"可以改写"的名额。
    expect(prompt).toContain('BODY-PDF-REPORT')
    expect(prompt).not.toContain('BODY-PDF-MERGE')
    expect(prompt).not.toContain('BODY-IMAGE-CROP')
    // 但清单是完整的：重复造一个已有技能比不写更糟，所以它必须看得见全部。
    expect(prompt).toContain('- `image-crop`: Crop an image.')
    expect(prompt).toContain('- `pdf-merge`: Merge two PDF files.')
  })

  it('caps the listing and reports the overflow', async () => {
    const { session, subagents } = await harness({
      skills: [
        { name: 'alpha-skill', description: 'Alpha.', body: 'BODY-ALPHA' },
        { name: 'beta-skill', description: 'Beta.', body: 'BODY-BETA' },
        { name: 'gamma-skill', description: 'Gamma.', body: 'BODY-GAMMA' },
      ],
      config: { curateMaxListedSkills: 1, curateMaxTargets: 1 },
    })

    compact(session, 'Nothing in particular happened.')
    await waitForChild(subagents)

    const prompt = subagents.runs[0]!.prompt
    expect(prompt).toContain('…and 2 more this deployment owns.')
    expect(prompt.match(/^ {2}file: /gm)).toHaveLength(1)
  })

  it('hands over only the roots this deployment owns', async () => {
    const { session, subagents } = await harness({
      skills: [DEPLOY_SKILL],
      customSkills: [{ name: 'shared-tool', description: 'Someone else\'s skill.', body: 'BODY-SHARED' }],
    })

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    // 别的工具也在用的通用约定目录不在名单里：模型改写它等于替别人的程序动文件。
    const prompt = subagents.runs[0]!.prompt
    expect(prompt).not.toContain('shared-tool')
    expect(prompt).not.toContain('BODY-SHARED')
  })

  it('leaves the corpus alone when the compaction failed', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    compactFailing(session)
    await settleNothing()

    // 失败的那一次没有可信的摘要，而且那一刻会话最不可信：不放开手。
    expect(subagents.runs).toHaveLength(0)
  })

  it('never curates a subagent session', async () => {
    const { session, subagents } = await harness({
      skills: [DEPLOY_SKILL],
      sessionMeta: { origin: 'subagent', delegationDepth: 1 },
    })

    compact(session, 'The curation child did its own work.')
    await settleNothing()

    // 子 agent 自己的压缩不能再起孙 agent：那会长出一棵每次压缩加一层的树。
    expect(subagents.runs).toHaveLength(0)
  })

  it('runs one curation child at a time per session', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    compact(session, 'first compaction', 'c1')
    await waitForChild(subagents)
    compact(session, 'second compaction', 'c2')
    await settleNothing()
    // 前一个还没落地就不再起新的：它们会读同一份语料，同时写会互相覆盖。
    expect(subagents.runs).toHaveLength(1)

    subagents.settle('ok')
    await vi.waitFor(() => { expect(subagents.disposals).toHaveLength(1) })
    compact(session, 'third compaction', 'c3')
    await waitForChild(subagents, 2)
    expect(subagents.runs[1]?.prompt).toContain('third compaction')
  })

  it('does nothing without a subagent runtime', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL], withSubagents: false })

    compact(session, 'Deployed the docs site.')
    await settleNothing()

    expect(subagents.runs).toHaveLength(0)
  })

  it('stops at a boundary that closes no summary', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    // 没有摘要就没有可学的东西：这一次边界（例如被取消的压缩）留下语料不动。
    session.append('compaction/end', { compactionId: CompactionId('orphan'), turn: null })
    await settleNothing()

    expect(subagents.runs).toHaveLength(0)
  })

  it('curates a session that carries no workspace', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL], withoutCwd: true })

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    // 没有工作区就没有项目级根本可解析，但用户级的语料照旧是这份部署的。
    expect(subagents.runs[0]?.prompt).toContain('- `deploy-docs`: Deploy the documentation site to the host.')
  })

  it('passes an absolute skills dir through to the child unchanged', async () => {
    const { session, subagents } = await harness({
      skills: [DEPLOY_SKILL],
      config: { skillsDir: '/srv/skills' },
    })

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    expect(subagents.runs[0]?.prompt).toContain('`/srv/skills/<kebab-name>/SKILL.md`')
  })

  it('trims nothing when both child lists are explicitly empty', async () => {
    const { session, subagents } = await harness({
      skills: [DEPLOY_SKILL],
      config: { childTools: [], childOmitSections: [] },
    })

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    // 与显式命令同一条判据：空名单读作「别动工具集」，请求里两个字段都不出现。
    expect(subagents.runs[0]?.allowTools).toBeUndefined()
    expect(subagents.runs[0]?.omitSections).toBeUndefined()
  })

  it('lists a skill whose body has vanished without printing it in full', async () => {
    const { ctx, session, subagents } = await harness({})
    ctx.skills.registerProvider(() => ({
      name: 'ghost-probe',
      async list() {
        return [{
          name: 'ghost-skill',
          description: 'Listed but unreadable.',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh',
          provider: 'ghost-probe',
          path: '/nowhere/ghost-skill/SKILL.md',
          rank: 1,
          locator: 'ghost-skill',
        }]
      },
      async get() {
        return undefined
      },
    }))

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    // 正文在清单与加载之间消失时不能交出陈旧内容：它留在清单里（防重复），
    // 但不占"可以改写"的名额。
    const prompt = subagents.runs[0]!.prompt
    expect(prompt).toContain('- `ghost-skill`: Listed but unreadable.')
    expect(prompt).not.toContain('<existing_skill')
  })

  it('does nothing when the calling agent is no longer registered', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL], registerAgent: false })

    compact(session, 'Deployed the docs site.')
    await settleNothing()

    // 没有调用方就没有可挂的父子关系，也没有"这份语料对谁可见"的答案。
    expect(subagents.runs).toHaveLength(0)
  })

  it('leaves the corpus alone while discovery is incomplete', async () => {
    const { ctx, session, subagents } = await harness({ skills: [DEPLOY_SKILL] })
    ctx.skills.registerProvider(() => ({
      name: 'failing',
      async list() {
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))

    compact(session, 'Deployed the docs site.')
    await settleNothing()

    // 没看到的那部分正是"已经有人写过了"的证据：不完整的目录不能当依据。
    expect(subagents.runs).toHaveLength(0)
  })

  it('writes nothing while autoCurate is off', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL], config: { autoCurate: false } })

    compact(session, 'Deployed the docs site.')
    await settleNothing()

    expect(subagents.runs).toHaveLength(0)
  })

  it('swallows a start failure so the session turn is never affected', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })
    subagents.failStart()

    compact(session, 'Deployed the docs site.')
    await settleNothing()

    expect(subagents.runs).toHaveLength(0)
  })

  it('aborts an in-flight child when the plugin unloads', async () => {
    const { fiber, session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)
    const child = subagents.runs[0]!
    expect(child.signal.aborted).toBe(false)

    await fiber.dispose()

    expect(child.signal.aborted).toBe(true)
  })

  it('contains a failing drain instead of leaking a rejection', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)
    subagents.failDispose()
    subagents.settle('fail')

    // 子 agent 崩了、dispose 也崩了：两条都不许冒到会话上去。
    await vi.waitFor(() => { expect(subagents.disposals).toHaveLength(1) })
  })
})

describe('curation selection', () => {
  function summary(overrides: Partial<SkillSummary> & { name: string }): SkillSummary {
    return {
      description: `${overrides.name} description`,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'user-dsh',
      provider: 'filesystem',
      ...overrides,
    }
  }

  it('keeps only owned, file-backed skills', () => {
    const owned = summary({ name: 'owned', path: '/skills/owned/SKILL.md' })
    const bundled = summary({ name: 'bundled', source: 'bundled', path: '/bundle/bundled/SKILL.md' })
    const virtual = summary({ name: 'virtual' })

    expect(SummarizeSkill.curatableSkills([owned, bundled, virtual])).toEqual([owned])
  })

  it('prints long descriptions as one capped line', async () => {
    const long = summary({ name: 'chatty', description: 'word '.repeat(80), path: '/skills/chatty/SKILL.md' })

    const { owned } = await SummarizeSkill.selectCurationTargets(
      [long], 'anything', 1, () => Promise.resolve({ name: 'chatty', content: 'body' }),
    )

    expect(owned[0]?.description).toHaveLength(200)
    expect(owned[0]?.description.endsWith('...')).toBe(true)
  })

  it('drops a target whose body vanished between the listing and the load', async () => {
    const target = summary({ name: 'gone', path: '/skills/gone/SKILL.md' })

    const { owned, targets } = await SummarizeSkill.selectCurationTargets(
      [target], 'gone', 1, () => Promise.resolve(undefined),
    )

    expect(owned.map(skill => skill.name)).toEqual(['gone'])
    expect(targets).toEqual([])
  })

  it('tells the child the corpus is empty when nothing is owned', () => {
    const prompt = SummarizeSkill.buildCurationPrompt({
      summary: 'did something',
      skillsDir: '.dsh/skills',
      owned: [],
      omitted: 0,
      targets: [],
    })

    expect(prompt[0]?.type).toBe('text')
    if (prompt[0]?.type !== 'text') throw new Error('expected text prompt')
    expect(prompt[0].text).toContain('owns no skills yet')
    expect(prompt[0].text).toContain('No existing skill ranked high enough')
  })

  it('recognizes only a top-level session as curatable', () => {
    const id = SessionId('curatable-probe')
    const header = (extra: Record<string, unknown>) => ({
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, ...extra,
    }) as never
    const top = Session.create(id, [], header({}))
    const origin = Session.create(id, [], header({ origin: 'subagent' }))
    const deep = Session.create(id, [], header({ delegationDepth: 2 }))
    const seeded = Session.create(id, [], header({ parentSession: SessionId('parent') }))

    expect(SummarizeSkill.isCuratableSession(top)).toBe(true)
    expect(SummarizeSkill.isCuratableSession(origin)).toBe(false)
    expect(SummarizeSkill.isCuratableSession(deep)).toBe(false)
    // 用户自己开的分支也是顶层会话：`parentSession` 记的是血缘，不是委派深度。
    expect(SummarizeSkill.isCuratableSession(seeded)).toBe(true)
  })
})
