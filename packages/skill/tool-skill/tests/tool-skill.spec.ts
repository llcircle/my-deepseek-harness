import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  SESSION_FORMAT_VERSION, Session, SessionId, type UserMessage,
} from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import { catalogTranslationFiles, catalogUsesChinese, loadCatalogTranslations } from '@deepseek-ai/dsh-tool-skill'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const testToolSignal = new AbortController().signal

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(
  home: string,
  config: toolSkill.Config = {},
  promptLocale?: 'en' | 'zh',
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, promptLocale === undefined ? {} : { promptLocale })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agentForCwd(cwd: string): Agent {
  const id = SessionId(`tool-skill-${cwd}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function proposeStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
): Promise<PreStepDecision> {
  const signal = new AbortController().signal
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

/**
 * The catalog text the calling agent's own assembly carries.
 *
 * The plugin contributes the catalog as the ordered `skills:catalog`
 * system-prompt section and fills it from the `system-prompt/assemble`
 * listener, so "what the model is told about available skills" is one assembly
 * away — keyed by the calling agent, resolved fresh on every assembly, and
 * never a durable message the session has to carry, deduplicate, or replace.
 */
async function catalogFor(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(signal === undefined ? { agent } : { agent, signal })
  return assembly.sections.find(section => section.name === 'skills:catalog')?.text ?? ''
}

/** The same lookup for the agent a bare cwd identifies. */
async function catalogForCwd(ctx: Context, cwd: string, signal?: AbortSignal): Promise<string> {
  return await catalogFor(ctx, agentForCwd(cwd), signal)
}

async function mintAgentScope(ctx: Context, subject: string | Agent): Promise<{ agent: Agent; scope: Scope }> {
  const agent = typeof subject === 'string' ? agentForCwd(subject) : subject
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools'],
  }))
  return { agent, scope }
}

describe('dsh-tool-skill', () => {
  it('registers the skill tool schema and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })
    ctx.skills.register({ name: 'lifecycle-skill', description: 'Lifecycle', source: 'runtime', content: 'body' })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
    expect(await catalogForCwd(ctx, '/workspace')).toContain('lifecycle-skill')
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await catalogForCwd(ctx, '/workspace')).toBe('')

    toolSkill.apply(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
  })

  it('forwards the assembly signal to skill discovery', async () => {
    const home = await tempDir('tool-prefix-signal')
    const ctx = await setup(home)
    let seenSignal: AbortSignal | undefined
    ctx.skills.registerProvider(() => ({
      name: 'signal-probe',
      async list(options) {
        seenSignal = options.signal
        return []
      },
      async get() {
        return undefined
      },
    }))
    const controller = new AbortController()

    await catalogForCwd(ctx, '/workspace', controller.signal)

    expect(seenSignal).toBe(controller.signal)
  })

  it('renders a stable name-and-description catalog from the live snapshot', async () => {
    const home = await tempDir('tool-catalog')
    const ctx = await setup(home, { catalogDescriptionMaxLength: 50 })
    ctx.skills.register({
      name: 'z-skill',
      description: 'Long   description '.repeat(5),
      whenToUse: 'Never render this routing hint.',
      source: 'secret-source',
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: '/secret/path' },
      content: 'Secret body.',
    })
    ctx.skills.register({
      name: 'a-skill',
      description: 'Use {{placeholder}} <safely> & carefully.',
      source: 'runtime',
      provider: 'runtime',
      content: 'A body.',
    })
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill.',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only body.',
    })
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: 'later contribution' }],
            source: { kind: 'plugin', plugin: 'later-contribution' },
          }),
        ],
      }
    })

    const catalog = await catalogForCwd(ctx, '/workspace')

    // 目录是系统提示词里的一段文本，不是会话消息：其它插件往 pre-step 里加多少
    // 条注入都不影响它，反之亦然。
    expect(catalog).toContain([
      '<system-reminder>',
      'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
      '',
      '<available_skills>',
      '- `a-skill`: Use {{placeholder}} &lt;safely&gt; &amp; carefully.',
      '- `model-only-skill`: Model-only skill.',
      '- `z-skill`: Long description Long description Long descript...',
      '</available_skills>',
      '',
      "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
      '</system-reminder>',
    ].join('\n'))
    expect(catalog).not.toContain('whenToUse')
    expect(catalog).not.toContain('secret-source')
    expect(catalog).not.toContain('/secret/path')
    expect(catalog).not.toContain('Secret body')
    expect(catalog).not.toContain('user-only-skill')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ agent: agentForCwd('/workspace') })))
      .toContain('<available_skills>')
  })

  it('renders no catalog when no model-invocable skills are available', async () => {
    const home = await tempDir('tool-empty-catalog')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })

    // 段仍然注册着（它总是存在），但文本为空，所以渲染里连 system-reminder 都没有。
    expect(await catalogForCwd(ctx, '/workspace')).toBe('')
    expect(await catalogForCwd(ctx, '/workspace')).toBe('')
  })

  it('renders the whole catalog in Chinese when the assembly language is Chinese', async () => {
    const home = await tempDir('tool-zh-catalog')
    const ctx = await setup(home, {}, 'zh')
    ctx.skills.register({
      name: 'a-skill',
      description: 'English description.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      content: 'Body.',
    })
    ctx.skills.register({
      name: 'untranslated-skill',
      description: 'Untranslated description.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      content: 'Body.',
    })
    const cwd = await tempDir('tool-zh-cwd')
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(
      join(cwd, '.dsh', 'skill-translations.zh.json'),
      JSON.stringify({ 'a-skill': { description: '中文描述。' } }),
    )

    const agent = agentForCwd(cwd)
    const catalog = await catalogFor(ctx, agent)

    expect(catalog).toContain('技能是一组可复用的任务专用指令。')
    expect(catalog).toContain('中文描述。')
    // 档案没覆盖的技能保留英文描述：目录宁可半译，也不编造。
    expect(catalog).toContain('Untranslated description.')
    expect(catalog).not.toContain('English description.')
    expect(catalog).not.toContain('A skill is a reusable set')
  })

  it('lets an explicit catalogLocale of en outrank a Chinese assembly language', async () => {
    const home = await tempDir('tool-en-catalog')
    const ctx = await setup(home, { catalogLocale: 'en' }, 'zh')
    ctx.skills.register({
      name: 'a-skill',
      description: 'English description.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      content: 'Body.',
    })
    const cwd = await tempDir('tool-en-cwd')
    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(
      join(cwd, '.dsh', 'skill-translations.zh.json'),
      JSON.stringify({ 'a-skill': { description: '中文描述。' } }),
    )

    const catalog = await catalogFor(ctx, agentForCwd(cwd))

    expect(catalog).toContain('A skill is a reusable set')
    expect(catalog).not.toContain('中文描述。')
  })

  it('rebuilds the catalog on every assembly, so a later archive switches the whole catalog', async () => {
    // 目录不再是一条"发布过的"会话消息：译文档案出现后，下一次装配就是中文，
    // 既没有替换消息，也不需要会话承载任何目录状态。
    const home = await tempDir('tool-zh-replace')
    const ctx = await setup(home, {}, 'zh')
    ctx.skills.register({
      name: 'a-skill',
      description: 'English description.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      content: 'Body.',
    })
    const cwd = await tempDir('tool-zh-replace-cwd')
    const agent = agentForCwd(cwd)
    expect(await catalogFor(ctx, agent)).toContain('English description.')

    await mkdir(join(cwd, '.dsh'), { recursive: true })
    await writeFile(
      join(cwd, '.dsh', 'skill-translations.zh.json'),
      JSON.stringify({ 'a-skill': { description: '中文描述。' } }),
    )

    const switched = await catalogFor(ctx, agent)
    expect(switched).toContain('技能是一组可复用的任务专用指令。以下技能在当前会话中可用：')
    expect(switched).toContain('中文描述。')
    expect(switched).not.toContain('English description.')
    expect(switched).not.toContain('A skill is a reusable set')
  })

  it('omits the catalog while any provider discovery is incomplete', async () => {
    const home = await tempDir('tool-incomplete-prefix')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    let failing = true
    const provider = {
      name: 'recovering',
      async list() {
        if (failing) throw new Error('temporarily unavailable')
        return []
      },
      async get() {
        return undefined
      },
    }
    let invalidate = (): void => {}
    ctx.skills.registerProvider((control) => {
      invalidate = control.invalidate
      return provider
    })
    const agent = agentForCwd('/workspace')

    // 一次不完整的发现不能把「可能还有别的技能」安静地说成「技能就这些」：
    // 宁可这一节空着，也不要给模型一份它无法信任的清单。
    expect(await catalogFor(ctx, agent)).toBe('')

    failing = false
    invalidate()

    expect(await catalogFor(ctx, agent)).toContain('listed-skill')
  })

  it('rebuilds the catalog from the live registry on every assembly', async () => {
    const home = await tempDir('tool-dynamic-catalog')
    const ctx = await setup(home)
    const disposeFirst = ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const agent = agentForCwd('/workspace')

    const initial = await catalogFor(ctx, agent)
    expect(initial).toContain('first-skill')
    expect(initial).not.toContain('second-skill')

    const disposeSecond = ctx.skills.register({
      name: 'second-skill',
      description: 'Second skill',
      source: 'runtime',
      content: 'Second body.',
    })
    const widened = await catalogFor(ctx, agent)
    expect(widened).toContain('first-skill')
    expect(widened).toContain('second-skill')

    disposeSecond()
    disposeFirst()

    // 全部注销后这一节不再有内容——既不保留上一版目录，也不需要墓碑消息去
    // 撤销它：下一次装配就是事实。
    expect(await catalogFor(ctx, agent)).toBe('')
  })

  it('keeps body-only edits out of the catalog and loads the latest body on demand', async () => {
    const home = await tempDir('tool-body-refresh')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'body-skill', 'Stable description', 'First body.')
    const ctx = await setup(home)
    const agent = agentForCwd('/workspace')

    const before = await catalogFor(ctx, agent)
    expect(before).toContain('Stable description')

    await writeSkill(root, 'body-skill', 'Stable description', 'Second body.')

    // 正文改动不该让目录变化：目录每次都重新装配，一旦它带上正文，
    // 每次编辑技能都会把整段系统提示词的缓存打掉。
    expect(await catalogFor(ctx, agent)).toBe(before)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('body-refresh'),
      name: 'skill',
      arguments: { name: 'body-skill' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Second body.')
    expect(JSON.stringify(result.content)).not.toContain('First body.')
  })

  it('resolves the layered registry as the calling agent sees it', async () => {
    const home = await tempDir('tool-scoped-layer')
    const ctx = await setup(home)
    const { agent, scope } = await mintAgentScope(ctx, '/workspace/scoped')
    const scopedSkills = scope.ctx.get('skills')
    if (scopedSkills === undefined) throw new Error('skills service missing')
    scopedSkills.register({
      name: 'preset-only-skill',
      description: 'Visible to the scoped agent alone',
      source: 'preset',
      content: 'Preset-only body.',
    })

    // 目录按调用方作用域解析：同一个 ctx，两个 agent 看到两份不同的清单。
    expect(await catalogFor(ctx, agent)).toContain('preset-only-skill')
    expect(await catalogForCwd(ctx, '/workspace/other')).not.toContain('preset-only-skill')

    const scoped = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('scoped-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent,
    })
    expect(scoped.isError).toBe(false)
    expect(JSON.stringify(scoped.content)).toContain('Preset-only body.')

    const foreign = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('foreign-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent: agentForCwd('/workspace/other'),
    })
    expect(foreign.isError).toBe(true)
    await scope.dispose()
  })

  it('keeps the catalog empty rather than stale when a provider disappears mid-flight', async () => {
    const home = await tempDir('tool-incomplete-catalog')
    const ctx = await setup(home)
    const disposeStable = ctx.skills.register({
      name: 'stable-skill',
      description: 'Stable skill',
      source: 'runtime',
      content: 'Stable body.',
    })
    const agent = agentForCwd('/workspace')
    expect(await catalogFor(ctx, agent)).toContain('stable-skill')

    ctx.skills.registerProvider(() => ({
      name: 'failing',
      async list() {
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))
    disposeStable()

    // 目录没有「上一版」可言：它每次装配都从当前快照重建，所以发现不完整时
    // 只会空着，不会端出一份已经过期的清单。
    expect(await catalogFor(ctx, agent)).toBe('')
  })

  it('omits catalog guidance when the calling agent restricts away the shipped skill tool', async () => {
    const home = await tempDir('tool-restricted-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const agent = agentForCwd('/workspace')
    const { scope } = await mintAgentScope(ctx, agent)
    scope.ctx.tools.restrict({ deny: ['skill'] })

    expect(ctx.tools.get('skill', agent)).toBeUndefined()

    // 看不到 `skill` 工具的会话不该被告诉「这些技能可用」：它没有任何办法
    // 加载其中任何一个。
    expect(await catalogFor(ctx, agent)).toBe('')
    await scope.dispose()

    expect(await catalogForCwd(ctx, '/workspace')).toContain('listed-skill')
  })

  it('does not attach shipped catalog guidance to a scoped same-name tool shadow', async () => {
    const home = await tempDir('tool-shadowed-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const { agent, scope } = await mintAgentScope(ctx, '/workspace')
    scope.ctx.tools.register(defineContentToolFixture({
      name: 'skill',
      description: 'A scoped tool with unrelated semantics.',
      parameters: {},
      execute() {
        return Promise.resolve([{ type: 'text', text: 'shadow' }])
      },
    }))

    expect(ctx.tools.get('skill', agent)).not.toBe(ctx.tools.get('skill'))

    // 同名工具被替换成语义无关的东西时，目录指引必须跟着消失：它描述的
    // 是「用那份工具去加载」，而那份工具已经不在了。
    expect(await catalogFor(ctx, agent)).toBe('')
    await scope.dispose()

    expect(await catalogFor(ctx, agent)).toContain('listed-skill')
  })

  it('validates the catalog description cap', async () => {
    const home = await tempDir('tool-invalid-catalog-cap')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), agentsHome: join(home, '.agents'), watch: false })

    await expect(ctx.plugin(toolSkill, { catalogDescriptionMaxLength: 2 })).rejects.toThrow('greater than or equal to 3')
  })

  it('loads a skill for the calling agent cwd', async () => {
    const home = await tempDir('tool-load')
    const project = await tempDir('tool-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill', 'Project instructions.')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'skill',
      arguments: { name: 'project-skill' },
      agent: { session: { header: { cwd: project } } } as never,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    expect(result.value).toEqual({
      name: 'project-skill',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(project, '.dsh/skills/project-skill') },
      content: 'Project instructions.',
    })
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected text skill result')
    expect(block.text).toBe([
      '<skill_content name="project-skill">',
      '<skill_resources>',
      `Base directory for this skill: ${join(project, '.dsh/skills/project-skill')}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      'Project instructions.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'))
    expect(block.text).not.toContain('# Skill:')
  })

  it('renders provider-managed resource hints for non-local skills', async () => {
    const home = await tempDir('tool-resource-hints')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'opaque-skill',
      description: 'Opaque skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      content: 'Opaque instructions.',
    })
    ctx.skills.register({
      name: 'url-skill',
      description: 'URL skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'url', url: 'https://skills.example.test/url-skill' },
      content: 'URL instructions.',
    })
    ctx.skills.register({
      name: 'provider-skill',
      description: 'Provider skill',
      source: 'runtime',
      provider: 'runtime',
      content: 'Provider instructions.',
    })

    const opaque = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c2'), name: 'skill', arguments: { name: 'opaque-skill' } })
    const url = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'url-skill' } })
    const provider = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c4'), name: 'skill', arguments: { name: 'provider-skill' } })

    if (opaque.content[0]?.type !== 'text' || url.content[0]?.type !== 'text' || provider.content[0]?.type !== 'text') {
      throw new Error('expected text tool results')
    }
    expect(opaque.content[0].text).toContain('<skill_resources>\nResources for this skill: runtime memory\nLoad referenced resources only as needed.\n</skill_resources>')
    expect(url.content[0].text).toContain('<skill_resources>\nBase URL for this skill: https://skills.example.test/url-skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.\n</skill_resources>')
    expect(provider.content[0].text).toContain('<skill_resources>\nResources for this skill are managed by provider "runtime".\nLoad referenced resources only as needed.\n</skill_resources>')
  })

  it('rejects an unknown resource-base kind at the canonical output boundary', async () => {
    const home = await tempDir('tool-resource-assert-never')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'rogue-resource-skill',
      description: 'Rogue resource skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'future' } as never,
      content: 'Rogue instructions.',
    })

    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c5'), name: 'skill', arguments: { name: 'rogue-resource-skill' } })

    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain('value.resourceBase')
  })

  it('returns isError for unknown, invalid, and model-disabled skills', async () => {
    const home = await tempDir('tool-errors')
    await writeSkill(join(home, '.dsh/skills'), 'hidden-skill', 'Hidden skill', 'Hidden instructions.')
    await writeFile(join(home, '.dsh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden skill\ndisable-model-invocation: true\n---\n\nHidden instructions.\n')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })

    const unknown = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'skill', arguments: { name: 'missing' } })
    const invalid = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c2'), name: 'skill', arguments: { name: 'Bad_Name' } })
    const disabled = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'hidden-skill' } })
    const modelOnly = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c4'), name: 'skill', arguments: { name: 'model-only-skill' } })

    expect(unknown.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(disabled.isError).toBe(true)
    expect(modelOnly.isError).toBe(false)
    const unknownBlock = unknown.content[0]
    if (unknownBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(unknownBlock.text).toContain('skill "missing" is unknown or no longer available')
  })

  it('checks model policy before provider loading and rechecks the loaded definition', async () => {
    const home = await tempDir('tool-policy-before-load')
    const ctx = await setup(home)
    const getCalls: string[] = []
    ctx.skills.registerProvider(() => ({
      name: 'policy-probe',
      async list() {
        return [
          {
            name: 'denied-skill',
            description: 'Denied skill',
            invocation: { modelInvocable: false, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'denied-skill',
          },
          {
            name: 'policy-race-skill',
            description: 'Policy race skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'policy-race-skill',
          },
          {
            name: 'vanishing-skill',
            description: 'Vanishing skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'vanishing-skill',
          },
        ]
      },
      async get(candidate) {
        getCalls.push(candidate.name)
        if (candidate.name === 'vanishing-skill') return undefined
        return {
          ...candidate,
          invocation: { modelInvocable: false, userInvocable: true },
          content: 'Instructions must not be disclosed.',
        }
      },
    }))

    const denied = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c6'), name: 'skill', arguments: { name: 'denied-skill' } })
    const raced = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c7'), name: 'skill', arguments: { name: 'policy-race-skill' } })
    const vanished = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c8'), name: 'skill', arguments: { name: 'vanishing-skill' } })

    expect(denied.isError).toBe(true)
    expect(raced.isError).toBe(true)
    expect(vanished.isError).toBe(true)
    expect(getCalls).toEqual(['policy-race-skill', 'vanishing-skill'])
    for (const result of [denied, raced]) {
      const block = result.content[0]
      if (block?.type !== 'text') throw new Error('expected text tool result')
      expect(block.text).toContain('is not available for model invocation')
      expect(block.text).not.toContain('Instructions must not be disclosed.')
    }
    const vanishedBlock = vanished.content[0]
    if (vanishedBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(vanishedBlock.text).toContain('skill "vanishing-skill" is unknown or no longer available')
  })
})

describe('user-explicit invocation injection', () => {
  async function writePolicySkill(root: string, name: string, description: string, policy: string, body: string): Promise<void> {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    const policyLines = policy === '' ? '' : `${policy}\n`
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${policyLines}---\n\n${body}\n`)
  }

  function gesture(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async function invokeHarness(): Promise<{ ctx: Context; agent: Agent }> {
    const home = await tempDir('invoke')
    const skillsRoot = join(home, '.agents', 'skills')
    await writePolicySkill(skillsRoot, 'hidden-demo', 'User-only demo', 'disable-model-invocation: true', 'Say the magic word: PINEAPPLE.')
    await writePolicySkill(skillsRoot, 'shared-skill', 'Ordinary skill', '', 'Shared instructions.')
    await writePolicySkill(skillsRoot, 'model-only-skill', 'Model only', 'user-invocable: false', 'Model-only instructions.')
    const ctx = await setup(home)
    return { ctx, agent: agentForCwd(home) }
  }

  it('injects a user-invocable skill named by a leading /token, after every other injection', async () => {
    const { ctx, agent } = await invokeHarness()
    const first = gesture('/hidden-demo what does this do')
    const second = gesture('plain follow-up prose')
    const decision = await proposeStep(ctx, agent, [first, second])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const kinds = decision.messages.map(message => (message.source as { kind: string }).kind)
    // Background injections (the catalog here) sit between the claimed batch
    // and the invoked body: the material the model must act on comes last.
    expect(kinds.slice(0, 2)).toEqual(['user', 'user'])
    expect(kinds.at(-1)).toBe('skill-invocation')
    expect(kinds.indexOf('skill-catalog')).toBeLessThan(kinds.indexOf('skill-invocation'))
    const injection = decision.messages.at(-1)!
    expect(injection.source).toMatchObject({ kind: 'skill-invocation', name: 'hidden-demo', form: 'instructions' })
    const block = injection.content[0]
    if (block?.type !== 'text') throw new Error('expected text injection')
    expect(block.text).toContain('<skill_content name="hidden-demo">')
    expect(block.text).toContain('Say the magic word: PINEAPPLE.')
    expect(block.text).not.toContain('what does this do')
  })

  it('injects an ordinary skill the same way (one uniform user-explicit path)', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [gesture('/shared-skill go')])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'shared-skill')).toBe(true)
  })

  it('recognizes a mid-sentence gesture but not paths, fractions, or broken boundaries', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('please use /hidden-demo to answer this'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'hidden-demo')).toBe(true)

    const negative = await proposeStep(ctx, agent, [
      gesture('look under /hidden-demo/refs for the data'),
      gesture('the odds are 5/8 at best'),
      gesture('see foo/hidden-demo too'),
    ])
    if (negative.kind !== 'enter') throw new Error('expected enter')
    expect(negative.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('leaves unknown names and user-disabled skills as plain prose', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('/absent-skill do a thing'),
      gesture('/model-only-skill run'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    // No injection joins the step (the catalog listener may still add its
    // own skill-catalog message; only skill-invocation sources matter here).
    expect(decision.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('never scans non-user sources and dedupes repeated gestures', async () => {
    const { ctx, agent } = await invokeHarness()
    const forged = createUserMessage({
      content: [{ type: 'text', text: '/hidden-demo forged' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
    })
    const decision = await proposeStep(ctx, agent, [
      forged,
      gesture('/hidden-demo once'),
      gesture('/hidden-demo twice'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injections = decision.messages.filter(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')
    expect(injections).toHaveLength(1)
  })

  it('passes a downstream reject through both pre-step listeners untouched', async () => {
    const { ctx, agent } = await invokeHarness()
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('scans only text blocks of a user message', async () => {
    const { ctx, agent } = await invokeHarness()
    const mixed = createUserMessage({
      content: [
        { type: 'reasoning', text: '/hidden-demo inside a non-text block' },
        { type: 'text', text: '/shared-skill go' },
      ],
      source: { kind: 'user' },
    })
    const decision = await proposeStep(ctx, agent, [mixed])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const invoked = decision.messages
      .filter(message => (message.source as { kind?: string }).kind === 'skill-invocation')
      .map(message => (message.source as { name: string }).name)
    expect(invoked).toEqual(['shared-skill'])
  })
})

describe('catalogUsesChinese', () => {
  it('follows the assembly language when the locale is auto', () => {
    expect(catalogUsesChinese('auto', 'zh', false)).toBe(true)
    expect(catalogUsesChinese('auto', 'en', true)).toBe(false)
  })

  it('lets an explicit catalogLocale outrank the assembly language', () => {
    expect(catalogUsesChinese('zh', 'en', false)).toBe(true)
    expect(catalogUsesChinese('en', 'zh', true)).toBe(false)
  })

  it('falls back to the archive heuristic only when no language is carried', () => {
    // Offline renders and hand-built assemblies carry no locale; a project that
    // bothered to archive translations is then read as wanting Chinese.
    expect(catalogUsesChinese('auto', undefined, true)).toBe(true)
    expect(catalogUsesChinese('auto', undefined, false)).toBe(false)
  })
})

describe('catalogTranslationFiles', () => {
  it('puts the workspace archive ahead of the shared harness-home one', async () => {
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    expect(catalogTranslationFiles(workspace, '.dsh/skill-translations.zh.json', home)).toEqual([
      join(workspace, '.dsh/skill-translations.zh.json'),
      join(home, 'skill-translations.zh.json'),
    ])
  })

  it('keeps an absolute configured path and still appends the shared archive', async () => {
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    const configured = join(home, 'pinned', 'skill-translations.zh.json')
    expect(catalogTranslationFiles(workspace, configured, home)).toEqual([
      configured,
      join(home, 'skill-translations.zh.json'),
    ])
  })

  it('lists the shared archive once when the configured path already is it', async () => {
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    const shared = join(home, 'skill-translations.zh.json')
    expect(catalogTranslationFiles(workspace, shared, home)).toEqual([shared])
  })
})

describe('loadCatalogTranslations', () => {
  it('covers a workspace that has no archive of its own from the shared one', async () => {
    // The defect this guards: skills live in a shared registry, so a catalog
    // translated for one project used to read as untranslated everywhere else.
    const home = await tempDir('translations-home')
    await writeFile(join(home, 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '测试驱动开发' },
    }), 'utf8')
    const workspace = await tempDir('translations-workspace')

    const translations = await loadCatalogTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toBe('测试驱动开发')
  })

  it('lets a workspace entry override the shared entry of the same name', async () => {
    const home = await tempDir('translations-home')
    await writeFile(join(home, 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '共享译文' },
      diagnose: { description: '共享诊断' },
    }), 'utf8')
    const workspace = await tempDir('translations-workspace')
    await mkdir(join(workspace, '.dsh'), { recursive: true })
    await writeFile(join(workspace, '.dsh', 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '本工作区译文' },
    }), 'utf8')

    const translations = await loadCatalogTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toBe('本工作区译文')
    expect(translations.get('diagnose')).toBe('共享诊断')
  })

  it('stays empty when neither archive exists or the workspace one is malformed', async () => {
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    expect((await loadCatalogTranslations(workspace, '.dsh/skill-translations.zh.json', home)).size).toBe(0)

    await mkdir(join(workspace, '.dsh'), { recursive: true })
    await writeFile(join(workspace, '.dsh', 'skill-translations.zh.json'), '{ not json', 'utf8')
    expect((await loadCatalogTranslations(workspace, '.dsh/skill-translations.zh.json', home)).size).toBe(0)
  })
})
