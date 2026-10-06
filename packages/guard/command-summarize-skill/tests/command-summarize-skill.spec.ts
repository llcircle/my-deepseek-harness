/**
 * Learning from a session's own work.
 *
 * The `/summarize-skill` command: no conversation text fails; recorded turns
 * start exactly one one-shot subagent carrying the excerpt and the skill
 * writing instructions; a missing subagent runtime fails loudly.
 *
 * The compaction pass runs up to TWO children with disjoint jobs and disjoint
 * permissions. The creation child is asked whether the work deserves a new skill
 * and may write one new file; it runs at every successful boundary. The
 * reflection child is asked whether a skill this stretch LOADED was wrong and may
 * rewrite only the files it was handed; it runs only when something was loaded.
 * A failed compaction, a subagent's own compaction, an unregistered calling
 * agent, an incomplete catalog, a pass already in flight, and `autoCurate:
 * false` all leave the corpus alone.
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
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry, { renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
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
  /** The run's label — how a test tells the two curation jobs apart. */
  readonly label: string | undefined
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
      label?: string
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
        label: request.label,
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

/** The labels of the children published so far, in publication order. */
function labels(subagents: SubagentStub): Array<string | undefined> {
  return subagents.runs.map(run => run.label)
}

/** The single text block of a prompt, as the tests read it. */
function promptText(prompt: ContentBlock[]): string {
  const block = prompt[0]
  if (block?.type !== 'text') throw new Error('expected a single text prompt block')
  return block.text
}

/**
 * Record one user-explicit skill invocation.
 *
 * The metadata path a real host publishes: the injected message carries the
 * `skill-invocation` source with the name as a FIELD, so nothing has to be
 * recovered by re-parsing a rendered body.
 * @param session - the session the invocation belongs to.
 * @param name - the invoked skill's name.
 */
function loadSkill(session: Session, name: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `/skill ${name}` }],
    source: { kind: 'skill-invocation', name, form: 'instructions' },
  }), { surfaceOp: 'append' })
}

/**
 * Record one `skill` tool result carrying a rendered body.
 *
 * The other path a session can load a skill by: the model called the tool, and
 * the name survives only inside the wrapper the shared renderer wrote.
 * @param session - the session the result belongs to.
 * @param name - the loaded skill's name.
 * @param body - the skill body the renderer embeds.
 */
function openedSkill(session: Session, name: string, body: string): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(`call-${name}`),
      content: [{ type: 'text', text: renderSkillContent({ name, provider: 'filesystem', content: body }) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

/** A session carrying exactly the events `record` appends, in order. */
function eventsOf(record: (session: Session) => void): readonly SessionEvent[] {
  const session = Session.create(SessionId('load-probe'), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId('load-probe'), createdAt: 0, isSeeded: false,
  })
  record(session)
  return session.snapshotEvents()
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

describe('reading skill loads off the log', () => {
  const BODY = 'Run pnpm run website:build, then copy dist to the host.'

  it('reads a user-explicit invocation from the message source', () => {
    const events = eventsOf((session) => {
      loadSkill(session, 'deploy-docs')
      // 普通的用户提问不是加载，注入的上下文也不是：只有带来源字段的那条算。
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'now deploy it' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    })

    expect(SummarizeSkill.loadedSkillNames(events)).toEqual(['deploy-docs'])
  })

  it('reads a tool-visible load out of the rendered body', () => {
    const events = eventsOf((session) => {
      openedSkill(session, 'deploy-docs', BODY)
      // 别的工具结果不是技能正文，哪怕它和正文一样长。
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call-read'),
          content: [{ type: 'text', text: 'a.txt' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    })

    expect(SummarizeSkill.loadedSkillNames(events)).toEqual(['deploy-docs'])
  })

  it('reads nothing out of events that load no skill', () => {
    const events = eventsOf((session) => {
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'done' }],
          source: { provider: 'mock', model: 'mock' },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
    })

    expect(SummarizeSkill.loadedSkillNames(events)).toEqual([])
  })

  it('keeps first-use order and collapses reloads', () => {
    const events = eventsOf((session) => {
      loadSkill(session, 'deploy-docs')
      openedSkill(session, 'pdf-merge', BODY)
      openedSkill(session, 'deploy-docs', BODY)
    })

    // 一段工作里第五次打开同一个技能，仍然只算用过它一个。
    expect(SummarizeSkill.loadedSkillNames(events)).toEqual(['deploy-docs', 'pdf-merge'])
  })

  it('ignores a recorded name that is empty', () => {
    const events = eventsOf((session) => {
      loadSkill(session, '')
    })

    expect(SummarizeSkill.loadedSkillNames(events)).toEqual([])
  })
})

describe('the compaction curation pass', () => {
  const DEPLOY_SKILL: SkillFixture = {
    name: 'deploy-docs',
    description: 'Deploy the documentation site to the host.',
    body: 'Run pnpm run website:build, then copy dist to the host.',
  }

  it('starts one creation child carrying the summary and the corpus listing', async () => {
    const { agent, session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    compact(session, 'The session rebuilt the docs site and copied dist to the host.')
    await waitForChild(subagents)

    const child = subagents.runs[0]!
    expect(labels(subagents)).toEqual(['skill-creation'])
    expect(child.provider).toBe('spawn')
    expect(child.parent).toBe(agent)
    // 子 agent 的活是写技能文件，工具集与显式命令那条路径一致。
    expect(child.allowTools).toEqual(['read', 'write'])
    expect(child.prompt).toContain('The session rebuilt the docs site and copied dist to the host.')
    expect(child.prompt).toContain('- `deploy-docs`: Deploy the documentation site to the host.')
    expect(child.prompt).toContain('.dsh/skills/<kebab-name>/SKILL.md')
    expect(child.prompt).toContain('ONE new file at most')
    expect(child.prompt).toContain('nothing to save')
    // 创建只拿到清单：它判的是"覆盖没覆盖"，看不到正文就不能决定去改它。
    expect(child.prompt).not.toContain(DEPLOY_SKILL.body)
  })

  it('starts the reflection child first when the stretch loaded an owned skill', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    openedSkill(session, 'deploy-docs', DEPLOY_SKILL.body)
    compact(session, 'The session rebuilt the docs site and copied dist to the host.')
    await waitForChild(subagents)

    const reflection = subagents.runs[0]!
    expect(reflection.label).toBe('skill-reflection')
    expect(reflection.allowTools).toEqual(['read', 'write'])
    expect(reflection.prompt).toContain('<loaded_skill name="deploy-docs"')
    expect(reflection.prompt).toContain(DEPLOY_SKILL.body)
    expect(reflection.prompt).toContain('Never create a skill')
    expect(reflection.prompt).toContain('nothing to improve')

    // 反思结算之后创建才起来，而且它拿到的清单是这次改写之后的。
    subagents.settle('ok')
    await waitForChild(subagents, 2)
    expect(labels(subagents)).toEqual(['skill-reflection', 'skill-creation'])
    expect(subagents.runs[1]?.prompt).toContain('- `deploy-docs`: Deploy the documentation site to the host.')
    expect(subagents.runs[1]?.prompt).not.toContain(DEPLOY_SKILL.body)
  })

  it('reads a user-explicit invocation from the metadata instead of a rendered body', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    loadSkill(session, 'deploy-docs')
    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    // 人主动调用的那条路上技能名是消息源里的一个字段，正文根本没出现过：反思能
    // 拿到这条技能只可能是读了这个字段。
    expect(subagents.runs[0]?.label).toBe('skill-reflection')
    expect(subagents.runs[0]?.prompt).toContain('<loaded_skill name="deploy-docs"')
  })

  it('never reflects on a loaded skill this deployment does not own', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    // 随包发布的技能也会被加载：它被用过，但不是本部署的文件，交出去等于替别人动文件。
    loadSkill(session, 'bundled-skill')
    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    expect(labels(subagents)).toEqual(['skill-creation'])
  })

  it('prints only the most recently loaded targets and reports the overflow', async () => {
    const { session, subagents } = await harness({
      skills: [
        { name: 'alpha-skill', description: 'Alpha.', body: 'BODY-ALPHA' },
        { name: 'beta-skill', description: 'Beta.', body: 'BODY-BETA' },
        { name: 'gamma-skill', description: 'Gamma.', body: 'BODY-GAMMA' },
      ],
      config: { curateMaxTargets: 2 },
    })

    loadSkill(session, 'alpha-skill')
    loadSkill(session, 'beta-skill')
    loadSkill(session, 'gamma-skill')
    compact(session, 'Did three things.')
    await waitForChild(subagents)

    const reflection = subagents.runs[0]!.prompt
    // 摘要说的是刚做完的活，所以最近用到的优先。
    expect(reflection).toContain('<loaded_skill name="beta-skill"')
    expect(reflection).toContain('<loaded_skill name="gamma-skill"')
    expect(reflection).not.toContain('<loaded_skill name="alpha-skill"')
    // 它得知道自己在看子集，否则会把没印出来的那些当成不存在。
    expect(reflection).toContain('1 earlier loaded skill(s) were left out of this printout')
  })

  it('collapses a skill reloaded within one window into one target', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    loadSkill(session, 'deploy-docs')
    openedSkill(session, 'deploy-docs', DEPLOY_SKILL.body)
    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    const reflection = subagents.runs[0]!.prompt
    expect(reflection.match(/<loaded_skill /g)).toHaveLength(1)
    expect(reflection).not.toContain('left out of this printout')
  })

  it('hands creation a listing taken after the reflection rewrite', async () => {
    const { ctx, session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    loadSkill(session, 'deploy-docs')
    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)
    // 反思子 agent 落盘会让目录失效（真实部署里由 provider 的 watcher 完成）。
    // 注册一个提供者走的是同一条失效路径。
    ctx.skills.registerProvider(() => ({
      name: 'late-probe',
      async list() {
        return [{
          name: 'late-skill',
          description: 'Appeared after reflection.',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'user-dsh',
          provider: 'late-probe',
          path: '/skills/late-skill/SKILL.md',
          rank: 1,
          locator: 'late-skill',
        }]
      },
      async get() {
        return undefined
      },
    }))
    subagents.settle('ok')

    await waitForChild(subagents, 2)
    expect(subagents.runs[1]?.prompt).toContain('- `late-skill`: Appeared after reflection.')
  })

  it('leaves the corpus alone when the refreshed listing comes back incomplete', async () => {
    const { ctx, session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    loadSkill(session, 'deploy-docs')
    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)
    // 同一条失效路径，但这次目录收不齐：没看到的那部分正是"已经有人写过了"的证据。
    ctx.skills.registerProvider(() => ({
      name: 'flaky-probe',
      async list() {
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))
    subagents.settle('ok')

    await vi.waitFor(() => { expect(subagents.disposals).toHaveLength(1) })
    await settleNothing()
    // 反思已经交出去了，但清单不完整就不能据此长出新技能。
    expect(labels(subagents)).toEqual(['skill-reflection'])
  })

  it('caps the listing and reports the overflow', async () => {
    const { session, subagents } = await harness({
      skills: [
        { name: 'alpha-skill', description: 'Alpha.', body: 'BODY-ALPHA' },
        { name: 'beta-skill', description: 'Beta.', body: 'BODY-BETA' },
        { name: 'gamma-skill', description: 'Gamma.', body: 'BODY-GAMMA' },
      ],
      config: { curateMaxListedSkills: 1 },
    })

    compact(session, 'Nothing in particular happened.')
    await waitForChild(subagents)

    const prompt = subagents.runs[0]!.prompt
    expect(prompt).toContain('…and 2 more this deployment owns.')
    expect(prompt.match(/^- `[a-z-]+`: /gm)).toHaveLength(1)
  })

  it('lists only the roots this deployment owns', async () => {
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

  it('runs one curation pass at a time per session', async () => {
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

  it('ends the load window at the boundary instead of carrying it forward', async () => {
    const { session, subagents } = await harness({ skills: [DEPLOY_SKILL] })

    loadSkill(session, 'deploy-docs')
    compact(session, 'first compaction', 'c1')
    await waitForChild(subagents)
    subagents.settle('ok')
    await waitForChild(subagents, 2)
    subagents.settle('ok')
    await vi.waitFor(() => { expect(subagents.disposals).toHaveLength(2) })

    // 第二段一次技能都没加载：上一段的那次不该被重新算一遍。
    compact(session, 'second compaction', 'c2')
    await waitForChild(subagents, 3)
    expect(labels(subagents)).toEqual(['skill-reflection', 'skill-creation', 'skill-creation'])
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

  it('lists an unreadable skill without ever handing it over for rewriting', async () => {
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

    loadSkill(session, 'ghost-skill')
    compact(session, 'Deployed the docs site.')
    await waitForChild(subagents)

    // 正文在清单与加载之间消失时不能交出陈旧内容：它留在清单里（防重复），但不占
    // "可以改写"的名额 —— 这次连反思子 agent 都没起。
    expect(labels(subagents)).toEqual(['skill-creation'])
    const prompt = subagents.runs[0]!.prompt
    expect(prompt).toContain('- `ghost-skill`: Listed but unreadable.')
    expect(prompt).not.toContain('<loaded_skill')
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

  it('prints long descriptions as one capped line', () => {
    const long = summary({ name: 'chatty', description: 'word '.repeat(80), path: '/skills/chatty/SKILL.md' })

    const { owned } = SummarizeSkill.selectOwnedListing([long], 1)

    expect(owned[0]?.description).toHaveLength(200)
    expect(owned[0]?.description.endsWith('...')).toBe(true)
  })

  it('counts the skills a listing cap swallowed', () => {
    const skills = ['a-skill', 'b-skill', 'c-skill'].map(name => summary({ name, path: `/skills/${name}/SKILL.md` }))

    const { owned, omitted } = SummarizeSkill.selectOwnedListing(skills, 2)

    expect(owned.map(skill => skill.name)).toEqual(['a-skill', 'b-skill'])
    expect(omitted).toBe(1)
  })

  it('loads nothing for a used name the owned corpus does not have', async () => {
    const mine = summary({ name: 'mine', path: '/skills/mine/SKILL.md' })
    const foreign = summary({ name: 'theirs', source: 'custom', path: '/shared/theirs/SKILL.md' })
    const load = vi.fn(() => Promise.resolve(undefined))

    const { targets, omitted } = await SummarizeSkill.selectReflectionTargets([mine, foreign], ['theirs'], 1, load)

    // 加载过但不是本部署的文件：不交出去，连读都不读。
    expect(targets).toEqual([])
    expect(omitted).toBe(0)
    expect(load).not.toHaveBeenCalled()
  })

  it('drops a target whose body vanished between the listing and the load', async () => {
    const target = summary({ name: 'gone', path: '/skills/gone/SKILL.md' })

    const { targets, omitted } = await SummarizeSkill.selectReflectionTargets(
      [target], ['gone'], 1, () => Promise.resolve(undefined),
    )

    expect(targets).toEqual([])
    expect(omitted).toBe(0)
  })

  it('keeps the most recent uses and counts the older ones as omitted', async () => {
    const skills = ['a-skill', 'b-skill', 'c-skill'].map(name => summary({ name, path: `/skills/${name}/SKILL.md` }))

    const { targets, omitted } = await SummarizeSkill.selectReflectionTargets(
      skills, ['a-skill', 'b-skill', 'c-skill'], 2,
      name => Promise.resolve({ name, content: `${name} body` }),
    )

    expect(targets.map(target => target.name)).toEqual(['b-skill', 'c-skill'])
    expect(targets[1]?.content).toBe('c-skill body')
    expect(omitted).toBe(1)
  })

  it('collapses a name loaded twice into one target', async () => {
    const skill = summary({ name: 'again', path: '/skills/again/SKILL.md' })

    const { targets } = await SummarizeSkill.selectReflectionTargets(
      [skill], ['again', 'again'], 3, () => Promise.resolve({ name: 'again', content: 'body' }),
    )

    expect(targets.map(target => target.name)).toEqual(['again'])
  })

  it('tells the creation child the corpus is empty when nothing is owned', () => {
    const text = promptText(SummarizeSkill.buildCreationPrompt({
      summary: 'did something',
      skillsDir: '.dsh/skills',
      owned: [],
      omitted: 0,
    }))

    expect(text).toContain('owns no skills yet')
    expect(text).not.toContain('already owns:')
  })

  it('still names the overflow when the cap swallowed the whole listing', () => {
    const text = promptText(SummarizeSkill.buildCreationPrompt({
      summary: 'did something',
      skillsDir: '.dsh/skills',
      owned: [],
      omitted: 4,
    }))

    expect(text).toContain('Skills this deployment already owns:')
    expect(text).toContain('- …and 4 more this deployment owns.')
  })

  it('prints each loaded target in full under its own marker', () => {
    const text = promptText(SummarizeSkill.buildReflectionPrompt({
      summary: 'did something',
      targets: [{ name: 'mine', description: 'Mine.', path: '/skills/mine/SKILL.md', content: 'the current body' }],
      omitted: 0,
    }))

    expect(text).toContain('<loaded_skill name="mine" path="/skills/mine/SKILL.md">')
    expect(text).toContain('the current body')
    expect(text).toContain('</loaded_skill>')
    expect(text).toContain('Only the files printed above are in scope')
    expect(text).not.toContain('left out of this printout')
  })

  it('prints a placeholder rather than an empty printout', () => {
    const text = promptText(SummarizeSkill.buildReflectionPrompt({
      summary: 'did something',
      targets: [],
      omitted: 0,
    }))

    expect(text).toContain('No skill was printed.')
  })

  it('says how many older loaded skills the cap left out', () => {
    const text = promptText(SummarizeSkill.buildReflectionPrompt({
      summary: 'did something',
      targets: [{ name: 'mine', description: 'Mine.', path: '/skills/mine/SKILL.md', content: 'the current body' }],
      omitted: 2,
    }))

    expect(text).toContain('2 earlier loaded skill(s) were left out of this printout; they are not in scope.')
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
