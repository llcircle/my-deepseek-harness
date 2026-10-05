import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  AssembleContext, PromptAssembly, renderContextSnapshot, renderPrompt,
  LOCALIZED_SECTIONS, localizedSectionNames, localizedSectionText, normalizePromptLocale,
} from '@deepseek-ai/dsh-system-prompt'
import type {
  PromptContextOrderName, PromptOverridesSettings, PromptSectionOrderName,
} from '@deepseek-ai/dsh-system-prompt'
// Relative import: the `./overrides` export maps to a built artifact, and this
// spec exercises the source.
import { apply as applyOverrides, readLocalePreference } from '../src/overrides.ts'

/**
 * Every assembly carries the plugin's own built-ins — `harness:identity`
 * and `deployment:persona-prefix` / `deployment:persona-suffix` (from config). Tests about
 * registry MECHANICS strip them with {@link contributed} to stay focused on
 * their own sections; the built-ins' behavior is pinned by its own describe.
 */
const BUILT_IN = ['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix']
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
// Declaration order IS the expected render order: `reusable` below takes this
// list as given, so a name must move here whenever its order moves. `TOOLS_SDK`
// sits next to `PTC_ONLY` on purpose — the rule at 800 points at the SDK, and
// the local-environments case below renders the list verbatim.
const SECTION_ORDER_NAMES = [
  'HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_PREFIX',
  'PLAN_POLICY', 'TEAM_POLICY', 'PTC_ONLY', 'TOOLS_SDK', 'FILE_REFERENCE', 'TOOL_BASH',
  'TOOL_PWSH', 'TOOL_READ', 'TOOL_WRITE', 'TOOL_EDIT', 'TOOL_GLOB',
  'TOOL_GREP', 'TOOL_JOBS', 'TOOL_PTY', 'TOOL_WEB_SEARCH', 'TOOL_WEB_FETCH',
  'TOOL_LSP', 'TOOL_SESSION_QUERY', 'TOOL_GOAL', 'TOOL_CORDIS', 'TOOL_WORKFLOW',
  'TOOL_RALPH', 'TOOL_SUBAGENT', 'TOOL_REPORT',
  'DELIVERABLE_FILE_REFERENCES', 'MCP_INTRO', 'ERROR_LESSONS', 'STRUCTURED_OUTPUT',
  'HARNESS_SOURCE', 'WEB_SURFACE', 'DEPLOYMENT_PERSONA_SUFFIX',
  'SKILL_CATALOG',
] as const satisfies readonly PromptSectionOrderName[]
const CONTEXT_ORDER_NAMES = [
  'SANDBOX_POLICY', 'APPROVAL_POLICY', 'SUBAGENT_DELEGATION', 'COMPUTER_USE_POLICY',
] as const satisfies readonly PromptContextOrderName[]
function contributed(assembly: PromptAssembly): PromptAssembly['sections'] {
  return assembly.sections.filter(section => !BUILT_IN.includes(section.name))
}

describe('SystemPrompt', () => {
  it('keeps repository section placements unique, integral, and at least ten apart', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const orders = SECTION_ORDER_NAMES.map(name => ctx.systemPrompt.getSectionOrder(name))
    expect(orders.every(Number.isInteger)).toBe(true)
    expect(new Set(orders).size).toBe(orders.length)
    const sorted = [...orders].sort((a, b) => a - b)
    expect(sorted.slice(1).every((order, index) => order - sorted[index]! >= 10)).toBe(true)
  })

  it('keeps reusable instructions identical across local environments', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { personaPrefix: 'Model {{model}}.', personaSuffix: 'In {{cwd}} on {{platform}}.' })
      let environment = { model: 'model-a', cwd: '/alice/project', platform: 'darwin', source: '/alice/dsh', url: 'http://127.0.0.1:3080' }
      for (const key of ['model', 'cwd', 'platform'] as const) {
        ctx.systemPrompt.variable(key, () => environment[key])
      }
      const reusable = SECTION_ORDER_NAMES.filter(name =>
        !['HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_PREFIX', 'HARNESS_SOURCE', 'WEB_SURFACE', 'DEPLOYMENT_PERSONA_SUFFIX', 'SKILL_CATALOG'].includes(name))
      for (const name of [...reusable].reverse()) {
        ctx.systemPrompt.section({ name, order: ctx.systemPrompt.getSectionOrder(name), text: name })
      }
      ctx.systemPrompt.section({
        name: 'source', order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'), text: () => environment.source,
      })
      ctx.systemPrompt.section({
        name: 'web', order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'), text: () => environment.url,
      })
      // 技能目录是部署侧清单，排在 persona 后缀之后（见 SECTION_ORDERS 的注释），
      // 所以它既不属于"可复用指令"，也不在本地路径那一组里，单独钉住位置。
      ctx.systemPrompt.section({
        name: 'SKILL_CATALOG', order: ctx.systemPrompt.getSectionOrder('SKILL_CATALOG'), text: 'SKILL_CATALOG',
      })
      const first = renderPrompt(await ctx.systemPrompt.assemble())
      environment = { model: 'model-a', cwd: 'C:/bob/project', platform: 'win32', source: 'C:/bob/dsh', url: 'http://127.0.0.1:4080' }
      const second = renderPrompt(await ctx.systemPrompt.assemble())
      const prefix = [IDENTITY, 'Model model-a.', ...reusable].join('\n\n') + '\n\n'
      expect(first).toBe(`${prefix}/alice/dsh\n\nhttp://127.0.0.1:3080\n\nIn /alice/project on darwin.\n\nSKILL_CATALOG`)
      expect(second).toBe(`${prefix}C:/bob/dsh\n\nhttp://127.0.0.1:4080\n\nIn C:/bob/project on win32.\n\nSKILL_CATALOG`)
      environment.model = 'model-b'
      expect(renderPrompt(await ctx.systemPrompt.assemble()))
        .toBe(second.replace('Model model-a.', 'Model model-b.'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps repository context placements unique and integral', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const orders = CONTEXT_ORDER_NAMES.map(name => ctx.systemPrompt.getContextOrder(name))
    expect(orders.every(Number.isInteger)).toBe(true)
    expect(new Set(orders).size).toBe(orders.length)
  })

  describe('built-in sections', () => {
    it('renders the environment after guidance and reports its strict interpolation errors', async () => {
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt, { personaPrefix: 'Model {{model}}.', personaSuffix: 'Workspace {{cwd}}.' })
        ctx.systemPrompt.variable('model', () => 'm')
        ctx.systemPrompt.section({ name: 'guidance', order: 100, text: 'Use tools.' })
        const unresolved = await ctx.systemPrompt.assemble()
        expect(() => renderPrompt(unresolved))
          .toThrow('unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"')
        ctx.systemPrompt.variable('cwd', () => '/work')
        expect(renderPrompt(await ctx.systemPrompt.assemble()))
          .toBe(`${IDENTITY}\n\nModel m.\n\nUse tools.\n\nWorkspace /work.`)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('registers the harness identity and the configured deployment persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: 'You are DeepSeek Harness.' })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(s => s.name)).toEqual([
        'harness:identity',
        'deployment:persona-prefix',
        'deployment:persona-suffix',
      ])
      expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\nYou are DeepSeek Harness.`)
      // The names are reserved by the plugin — one owner per section.
      expect(() => ctx.systemPrompt.section({ name: 'deployment:persona-prefix', order: 0, text: 'imposter' }))
        .toThrow('prompt section "deployment:persona-prefix" is already registered')
    })

    it('renders no persona section for a persona-less deployment (empty default)', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(IDENTITY)
    })

    it('can omit the harness identity for a deployment that owns the complete persona', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        personaPrefix: 'You are a helpful software engineer assistant.',
      })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(section => section.name)).toEqual(['deployment:persona-prefix', 'deployment:persona-suffix'])
      expect(renderPrompt(assembly)).toBe('You are a helpful software engineer assistant.')
    })

    it('can suppress runtime context without evaluating providers or accepting waterfall additions', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { includeRuntimeContext: false })
      let providerCalls = 0
      ctx.systemPrompt.context({
        name: 'policy',
        order: 0,
        text: () => `policy ${++providerCalls}`,
      })
      ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        assembly.contexts.push({ name: 'late', text: 'late context' })
        return next()
      })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.contexts).toEqual([])
      expect(providerCalls).toBe(0)
    })

    it('tolerates a schema-bypassing direct construction (personaPrefix omitted)', async () => {
      // ctx.plugin validates + defaults the config first; a direct construction
      // skips the schema, so the ctor's `?? ''` narrowing is what fires.
      const ctx = new Context()
      const service = new SystemPrompt(ctx, {})
      expect(renderPrompt(await service.assemble())).toBe(IDENTITY)
    })
  })

  it('assembles sections in order with context-resolved text and collected tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are DeepSeek Harness.' })

    ctx.systemPrompt.section({ name: 'cwd', order: 20, text: () => 'cwd: /tmp' })
    ctx.systemPrompt.section({ name: 'rules', order: 10, text: 'Be precise.' })
    ctx.systemPrompt.context({ name: 'later', order: 20, text: () => 'context 2' })
    ctx.systemPrompt.context({ name: 'earlier', order: 10, text: 'context 1' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'echo', description: 'echo back', parameters: {} }] }))

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'rules', 'cwd', 'deployment:persona-suffix'])
    expect(assembly.sections.map(s => s.text)).toEqual([IDENTITY, 'You are DeepSeek Harness.', 'Be precise.', 'cwd: /tmp', ''])
    expect(assembly.contexts).toEqual([
      { name: 'earlier', text: 'context 1' },
      { name: 'later', text: 'context 2' },
    ])
    expect(assembly.tools).toEqual([{ name: 'echo', description: 'echo back', parameters: {} }])
    expect(assembly.variables).toEqual({})
    expect(renderPrompt(assembly)).toBe(`${IDENTITY}\n\nYou are DeepSeek Harness.\n\nBe precise.\n\ncwd: /tmp`)
    // No settings-backed locale, so the assembly resolves to English — the snapshot
    // heading follows it rather than staying pinned to one language.
    expect(renderContextSnapshot(assembly))
      .toBe('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\ncontext 1\n\ncontext 2')
  })

  it('breaks equal section orders by code-unit name regardless of registration order', async () => {
    for (const names of [['äther', 'zeta'], ['zeta', 'äther']] as const) {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      for (const name of names) ctx.systemPrompt.section({ name, order: 10, text: name })
      expect(contributed(await ctx.systemPrompt.assemble()).map(section => section.name)).toEqual(['zeta', 'äther'])
    }
  })

  it('resolves section text providers against the assemble context, at each assemble call', async () => {
    // The context is HOW per-agent sections work (the loop passes { agent });
    // this spec stays agent-agnostic and smuggles a marker through a plain field.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let calls = 0
    ctx.systemPrompt.section({
      name: 'dynamic',
      order: 0,
      text: (context: AssembleContext) => `call ${++calls} for ${(context as { who?: string }).who ?? 'nobody'}`,
    })

    expect(contributed(await ctx.systemPrompt.assemble({ who: 'alice' } as AssembleContext))[0]!.text).toBe('call 1 for alice')
    expect(contributed(await ctx.systemPrompt.assemble())[0]!.text).toBe('call 2 for nobody')
  })

  it('removes contributions when the contributing fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'scoped', order: 0, text: 'scoped section' })
      inner.systemPrompt.context({ name: 'scoped-context', order: 0, text: 'scoped context' })
      inner.systemPrompt.tools(() => ({ schemas: [{ name: 'scoped-tool', description: '', parameters: {} }] }))
      inner.systemPrompt.variable('scoped_var', () => 'v')
    }, { inject: ['systemPrompt'] }))

    const before = await ctx.systemPrompt.assemble()
    expect(contributed(before)).toHaveLength(1)
    expect(before.contexts).toHaveLength(1)
    expect(before.variables).toEqual({ scoped_var: 'v' })
    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(contributed(assembly)).toHaveLength(0)
    expect(assembly.contexts).toHaveLength(0)
    // The built-ins belong to the service fiber, so they survive the plugin's disposal.
    expect(assembly.sections.map(s => s.name)).toEqual(BUILT_IN)
    expect(assembly.tools).toHaveLength(0)
    expect(assembly.variables).toEqual({})
  })

  it('rejects a duplicate section name (a double-loaded plugin must fail, not double its text)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'dup', order: 0, text: 'first' })
    expect(() => ctx.systemPrompt.section({ name: 'dup', order: 1, text: 'second' }))
      .toThrow('prompt section "dup" is already registered')
    // The failed registration leaked nothing; the original stays intact.
    const assembly = await ctx.systemPrompt.assemble()
    expect(contributed(assembly).map(s => s.text)).toEqual(['first'])
  })

  it('rejects a non-finite section order', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    expect(() => ctx.systemPrompt.section({ name: 'bad-order', order: Number.NaN, text: 'x' }))
      .toThrow('order must be a finite number')
    expect(contributed(await ctx.systemPrompt.assemble())).toEqual([])
  })

  it('rejects duplicate and non-finite context registrations without leaking', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'first' })
    expect(() => ctx.systemPrompt.context({ name: 'policy', order: 2, text: 'second' }))
      .toThrow('prompt context "policy" is already registered')
    expect(() => ctx.systemPrompt.context({ name: 'bad', order: Number.NaN, text: 'x' }))
      .toThrow('prompt context "bad" order must be a finite number')
    expect((await ctx.systemPrompt.assemble()).contexts).toEqual([{ name: 'policy', text: 'first' }])
  })

  it('rolls back a section when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    // Throw on the first emit only. Note the rollback path itself emits
    // system-prompt/change, so a multi-shot guard would also fire on rollback;
    // a single-shot guard isolates the register's own emit.
    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })).toThrow('boom change listener')
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(0) // nothing leaked

    // Subsequent listener-free register contributes exactly once.
    off()
    ctx.systemPrompt.section({ name: 'p', order: 0, text: 'persona' })
    expect(contributed(await ctx.systemPrompt.assemble()).map(s => s.name)).toEqual(['p'])
  })

  it('rolls back a tool provider when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: '', parameters: {} }] }))).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0) // nothing leaked

    off()
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: '', parameters: {} }] }))
    expect((await ctx.systemPrompt.assemble()).tools.map(t => t.name)).toEqual(['t'])
  })

  it('snapshots tool-provider membership before evaluating an assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let added = false
    ctx.systemPrompt.tools(() => {
      if (!added) {
        added = true
        ctx.systemPrompt.tools(() => ({
          schemas: [{ name: 'late', description: '', parameters: {} }],
        }))
      }
      return { schemas: [{ name: 'first', description: '', parameters: {} }] }
    })

    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['first'])
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toEqual(['first', 'late'])
  })

  it('rolls back a variable when a system-prompt/change listener throws (P1-1)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let threw = false
    const off = ctx.on('system-prompt/change', () => {
      if (!threw) { threw = true; throw new Error('boom change listener') }
    })

    expect(() => ctx.systemPrompt.variable('v', () => 'x')).toThrow('boom change listener')
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({}) // nothing leaked

    off()
    ctx.systemPrompt.variable('v', () => 'x')
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({ v: 'x' })
  })

  it('composes multiple system-prompt/assemble waterfall listeners in order, with the context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 10, text: 'base' })

    // Listener A appends a section, then delegates.
    const contexts: AssembleContext[] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context, next) => {
      contexts.push(context)
      assembly.sections.push({ name: 'from-a', text: 'a' })
      return next()
    })
    // Listener B (registered later, runs after A) sees A's contribution.
    const seen: string[][] = []
    ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, _context, next) => {
      seen.push(assembly.sections.map(s => s.name))
      return next()
    })

    const passed: AssembleContext = {}
    const assembly = await ctx.systemPrompt.assemble(passed)
    // Listeners see every registered section, empty optional ones included: the
    // "empty optional disappears" rule is a projection of the final prompt, and
    // it runs after the waterfall so a listener can still fill such a section.
    expect(seen).toEqual([['harness:identity', 'deployment:persona-prefix', 'base', 'deployment:persona-suffix', 'from-a']])
    expect(assembly.sections.map(s => s.name))
      .toEqual(['harness:identity', 'deployment:persona-prefix', 'base', 'deployment:persona-suffix', 'from-a'])
    // The caller's context reaches listeners, carrying the locale the registry resolved.
    expect(contexts[0]).toEqual({ ...passed, locale: 'en' })
  })

  it('lets a waterfall listener short-circuit by not calling next()', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'real', order: 0, text: 'real' })

    ctx.on('system-prompt/assemble', async () => {
      return { sections: [], contexts: [], tools: [], variables: {} } satisfies PromptAssembly
    })

    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections).toHaveLength(0)
  })

  it('restores one complete section after the assembly waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'complete', order: 10, text: 'Exact prompt.', complete: true })
    ctx.systemPrompt.section({ name: 'extra', order: 20, text: 'extra' })
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const complete = assembly.sections.find(section => section.name === 'complete')
      if (complete === undefined) throw new Error('complete section missing before waterfall')
      complete.text = 'mutated'
      assembly.sections.push({ name: 'late', text: 'late' })
      return next()
    }, { prepend: true })

    expect((await ctx.systemPrompt.assemble()).sections).toEqual([
      { name: 'complete', text: 'Exact prompt.' },
    ])
  })

  it('rejects multiple effective complete sections', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'first', order: 10, text: 'first', complete: true })
    ctx.systemPrompt.section({ name: 'second', order: 20, text: 'second', complete: true })

    await expect(ctx.systemPrompt.assemble())
      .rejects.toThrow('multiple complete prompt sections are active: "first", "second"')
  })

  it('assembles snapshots so one-step mutations do not leak into future assemblies', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.section({ name: 'base', order: 10, text: 'base' })
    ctx.systemPrompt.tools(() => ({ schemas: [{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }] }))

    const first = await ctx.systemPrompt.assemble()
    first.sections[0]!.name = 'mutated'
    first.sections[0]!.text = 'mutated'
    first.contexts.push({ name: 'mutated', text: 'mutated' })
    first.tools[0]!.description = 'mutated'
    const firstParameters = first.tools[0]!.parameters as { properties: Record<string, unknown> }
    firstParameters.properties['leak'] = { type: 'string' }

    const second = await ctx.systemPrompt.assemble()
    expect(second.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'base', 'deployment:persona-suffix'])
    expect(second.sections[0]!.text).toBe(IDENTITY)
    expect(second.contexts).toEqual([])
    expect(second.tools).toEqual([{ name: 't', description: 'tool', parameters: { type: 'object', properties: {} } }])
  })

  it('filters out empty section text from renderPrompt', () => {
    const result = renderPrompt({
      sections: [
        { name: 'empty', text: '' },
        { name: 'real', text: 'content' },
      ],
      contexts: [],
      tools: [],
      variables: {},
    })
    expect(result).toBe('content')
  })

  it('filters empty context, interpolates variables, and returns empty without active context', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    ctx.systemPrompt.context({ name: 'empty', order: 0, text: '' })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble())).toBe('')
    ctx.systemPrompt.variable('mode', () => 'read-only')
    ctx.systemPrompt.context({ name: 'policy', order: 1, text: 'Mode: {{mode}}.' })
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble()))
      .toBe('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nMode: read-only.')
  })

  it('attributes context interpolation failures to the contributing context', () => {
    expect(() => renderContextSnapshot({
      sections: [],
      contexts: [{ name: 'policy', text: 'Mode: {{missing}}.' }],
      tools: [],
      variables: {},
    })).toThrow('unknown prompt variable "{{missing}}" in context "policy"; registered variables: (none)')
  })

  it('emits system-prompt/change when a tool provider is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)

    const dispose = ctx.systemPrompt.tools(() => ({ schemas: [] }))
    // registration emits change
    expect(changeCount).toBe(1)

    dispose()
    // disposal emits change again
    expect(changeCount).toBe(2)
  })

  it('emits system-prompt/change when a context is registered and disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    let changeCount = 0
    ctx.on('system-prompt/change', () => void changeCount++)
    const dispose = ctx.systemPrompt.context({ name: 'policy', order: 0, text: 'current' })
    expect(changeCount).toBe(1)
    dispose()
    expect(changeCount).toBe(2)
  })

  it('cleans up tool providers on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.tools(() => ({ schemas: [{ name: 'fiber-tool', description: '', parameters: {} }] }))
    }, { inject: ['systemPrompt'] }))

    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)
    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  it('removes section when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.section({ name: 'direct', order: 0, text: 'direct section' })
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(1)

    dispose()
    expect(contributed(await ctx.systemPrompt.assemble())).toHaveLength(0)
  })

  it('removes tool provider when returned disposer is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)

    const dispose = ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'direct-tool', description: '', parameters: {} }] }))
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(1)

    dispose()
    expect((await ctx.systemPrompt.assemble()).tools).toHaveLength(0)
  })

  describe('prompt variables', () => {
    it('resolves each variable against the assemble context and emits change on register/unregister', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      let changeCount = 0
      ctx.on('system-prompt/change', () => void changeCount++)

      const dispose = ctx.systemPrompt.variable('who', context => (context as { who?: string }).who)
      expect(changeCount).toBe(1)

      expect((await ctx.systemPrompt.assemble({ who: 'alice' } as AssembleContext)).variables).toEqual({ who: 'alice' })
      // A provider returning undefined records "registered but no value here".
      expect((await ctx.systemPrompt.assemble()).variables).toEqual({ who: undefined })

      dispose()
      expect(changeCount).toBe(2)
      expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    })

    it('live-iterates variables registered by an earlier provider', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      let added = false
      ctx.systemPrompt.variable('first', () => {
        if (!added) {
          added = true
          ctx.systemPrompt.variable('late', () => 'second value')
        }
        return 'first value'
      })

      expect((await ctx.systemPrompt.assemble()).variables).toEqual({
        first: 'first value',
        late: 'second value',
      })
    })

    it('rejects a duplicate variable name and an unreferenceable name', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.variable('model', () => 'm1')
      expect(() => ctx.systemPrompt.variable('model', () => 'm2'))
        .toThrow('prompt variable "model" is already registered')
      expect(() => ctx.systemPrompt.variable('Not Valid', () => 'x'))
        .toThrow('invalid prompt variable name "Not Valid"')
      // Neither failed registration leaked.
      expect((await ctx.systemPrompt.assemble()).variables).toEqual({ model: 'm1' })
    })

    it('interpolates {{name}} references in section text at render — the persona included', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: 'You run on {{model}} in {{cwd}}.' })
      ctx.systemPrompt.variable('model', () => 'deepseek-v4')
      ctx.systemPrompt.variable('cwd', () => '/work')

      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nYou run on deepseek-v4 in /work.`)
    })

    it.each([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ])('preserves literal section text with complete=%s and dynamic=%s', async (complete, dynamic) => {
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: '{{model}}' })
        ctx.systemPrompt.variable('model', () => 'actual-model')
        const text = '{{item}} {{model}} {{ model }} {{nested{{item}}}}'
        ctx.systemPrompt.section({ name: 'literal', order: 1, text: dynamic ? () => text : text, interpolate: false, complete })
        expect(renderPrompt(await ctx.systemPrompt.assemble()))
          .toBe(complete ? text : `actual-model\n\n${text}`)
      } finally {
        await ctx.fiber.dispose()
      }
    })

    it('lets a waterfall listener add or override variables before render', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 's', order: 0, text: '{{extra}}' })
      ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, _context, next) => {
        assembly.variables['extra'] = 'from-waterfall'
        return next()
      })
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nfrom-waterfall`)
    })

    it('throws on a reference to an unregistered variable, listing what exists', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'persona', order: 0, text: 'on {{modle}}' })
      ctx.systemPrompt.variable('model', () => 'm')
      await expect(async () => renderPrompt(await ctx.systemPrompt.assemble()))
        .rejects.toThrow('unknown prompt variable "{{modle}}" in section "persona"; registered variables: model')
    })

    it('names "(none)" when no variables are registered at all', () => {
      expect(() => renderPrompt({ sections: [{ name: 's', text: '{{x}}' }], contexts: [], tools: [], variables: {} }))
        .toThrow('unknown prompt variable "{{x}}" in section "s"; registered variables: (none)')
    })

    it('throws when a referenced variable has no value for this assembly', () => {
      expect(() => renderPrompt({
        sections: [{ name: 'persona', text: 'in {{cwd}}' }],
        contexts: [],
        tools: [],
        variables: { cwd: undefined },
      })).toThrow('prompt variable "{{cwd}}" has no value for this assembly (section "persona")')
    })

    it('throws on a malformed complete reference, e.g. inner spaces', () => {
      expect(() => renderPrompt({
        sections: [{ name: 's', text: 'on {{ model }}' }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('malformed prompt variable reference "{{ model }}" in section "s"')
    })

    it('leaves a lone {{ verbatim only when NO }} follows anywhere after it', () => {
      const text = renderPrompt({
        sections: [{ name: 's', text: 'shell ${X:-{{fallback} stays' }],
        contexts: [],
        tools: [],
        variables: {},
      })
      expect(text).toBe('shell ${X:-{{fallback} stays')
    })

    it.each([
      { text: '{{{model}}}', label: 'extra outer braces' },
      { text: 'x {{a{b}} y {{model}}', label: 'nested brace inside a would-be group' },
    ])('throws on a mangled reference with a }} still following ($label)', ({ text }) => {
      expect(() => renderPrompt({
        sections: [{ name: 's', text }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('malformed prompt variable reference at')
    })

    it('rejects {{constructor}} as UNKNOWN — prototype properties are not variables', () => {
      // `in` would find Object.prototype.constructor and splice function
      // source into the prompt; Object.hasOwn must reject it instead.
      expect(() => renderPrompt({
        sections: [{ name: 's', text: 'on {{constructor}}' }],
        contexts: [],
        tools: [],
        variables: { model: 'm' },
      })).toThrow('unknown prompt variable "{{constructor}}"')
    })

    it('a variable NAMED like a prototype property works once actually registered', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 's', order: 0, text: '{{constructor}}' })
      ctx.systemPrompt.variable('constructor', () => 'own-value')
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(`${IDENTITY}\n\nown-value`)
    })

    it('never re-scans substituted values (a value containing {{sneaky}} stays literal)', () => {
      const text = renderPrompt({
        sections: [{ name: 's', text: 'v = {{model}}!' }],
        contexts: [],
        tools: [],
        variables: { model: 'literal {{sneaky}} inside' },
      })
      expect(text).toBe('v = literal {{sneaky}} inside!')
    })
  })

  describe('completePromptFile', () => {
    it('rejects a relative path at construction', async () => {
      const ctx = new Context()
      await expect(ctx.plugin(SystemPrompt, { completePromptFile: 'relative.md' }))
        .rejects.toThrow('completePromptFile must be an absolute path')
    })

    it('replaces every section with the file content when the file exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-complete-prompt-'))
      const file = join(dir, 'prompt.md')
      await writeFile(file, '你是 DeepSeek Harness 中文代理。', 'utf8')
      try {
        const ctx = new Context()
        await ctx.plugin(SystemPrompt, { completePromptFile: file })

        const assembly = await ctx.systemPrompt.assemble()
        expect(assembly.sections.map(s => s.name)).toEqual(['deployment:complete-prompt'])
        expect(renderPrompt(assembly)).toBe('你是 DeepSeek Harness 中文代理。')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('falls back to the standard assembly when the file is missing', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { completePromptFile: 'Z:\\nonexistent\\prompt.md' })

      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix'])
    })
  })

  describe('autoTranslatedPrompt', () => {
    it('uses the per-session translation file after it exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-translated-prompt-'))
      await mkdir(join(dir, '.dsh'), { recursive: true })
      const file = join(dir, '.dsh', 'system-prompt.zh.prompt.md')
      await writeFile(file, '你是 DeepSeek Harness 中文代理。', 'utf8')
      try {
        const ctx = new Context()
        await ctx.plugin(SystemPrompt, { personaPrefix: 'English persona.' })

        const assembly = await ctx.systemPrompt.assemble({ cwd: dir })
        expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('keeps the standard assembly when no translation exists or auto selection is disabled', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-untranslated-prompt-'))
      const translated = new Context()
      await translated.plugin(SystemPrompt, { personaPrefix: 'English persona.' })
      const disabled = new Context()
      await disabled.plugin(SystemPrompt, {
        autoTranslatedPrompt: false,
        personaPrefix: 'English persona.',
      })
      try {
        expect((await translated.systemPrompt.assemble({ cwd: dir })).sections.map(section => section.name))
          .toEqual(['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix'])

        await mkdir(join(dir, '.dsh'), { recursive: true })
        await writeFile(
          join(dir, '.dsh', 'system-prompt.zh.prompt.md'),
          '你是 DeepSeek Harness 中文代理。',
          'utf8',
        )
        expect((await disabled.systemPrompt.assemble({ cwd: dir })).sections.map(section => section.name))
          .toEqual(['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('replaces matching static sections while retaining dynamic sections', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-translated-prompt-plugin-'))
      await mkdir(join(dir, '.dsh'), { recursive: true })
      await writeFile(
        join(dir, '.dsh', 'system-prompt.zh.prompt.md'),
        [
          '翻译后的身份。',
          '',
          '翻译后的人设。',
          '',
          '翻译后的额外指引。',
        ].join('\n'),
        'utf8',
      )
      const ctx = new Context()
      // The archive is Chinese, so it is only consulted under the Chinese locale.
      await ctx.plugin(SystemPrompt, { personaPrefix: 'English persona.', promptLocale: 'zh' })
      ctx.systemPrompt.section({ name: 'plugin:catalog', order: 100, text: 'Plugin catalog.' })
      ctx.systemPrompt.section({ name: 'deployment:error-lessons', order: 150, text: 'Live lessons.' })
      ctx.systemPrompt.section({ name: 'plugin:extra', order: 200, text: 'Extra guidance.' })
      try {
        const assembly = await ctx.systemPrompt.assemble({ cwd: dir })
        expect(assembly.sections.map(section => section.name)).toEqual([
          'harness:identity',
          'deployment:persona-prefix',
          'plugin:catalog',
          'deployment:error-lessons',
          'plugin:extra',
          'deployment:persona-suffix',
        ])
        // The three archive paragraphs cover the first three replaceable static
        // sections in render order. The dynamic `deployment:error-lessons` keeps
        // its own text and consumes no paragraph — were it replaceable it would
        // have taken the third, and `plugin:extra` would have gone without.
        expect(renderPrompt(assembly)).toBe('翻译后的身份。\n\n翻译后的人设。\n\n翻译后的额外指引。\n\nLive lessons.\n\nExtra guidance.')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects an empty translation file rather than sending a blank prompt', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-empty-translated-prompt-'))
      await mkdir(join(dir, '.dsh'), { recursive: true })
      await writeFile(join(dir, '.dsh', 'system-prompt.zh.prompt.md'), '   ', 'utf8')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      try {
        await expect(ctx.systemPrompt.assemble({ cwd: dir }))
          .rejects.toThrow('is empty')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('projects English and Chinese current text for the prompt editor', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-editor-languages-'))
      await mkdir(join(dir, '.dsh'), { recursive: true })
      await writeFile(
        join(dir, '.dsh', 'system-prompt.zh.prompt.md'),
        '中文身份。\n\n中文早期。\n\n中文后期。\n\n中文额外指引。',
        'utf8',
      )
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      // 字母序和提示词序不同，用于捕获先排序再匹配翻译档案的错误。
      ctx.systemPrompt.section({ name: 'z-late', order: 100, text: 'Late source.' })
      ctx.systemPrompt.section({ name: 'a-early', order: 200, text: 'Early source.' })
      ctx.systemPrompt.section({ name: 'plugin:extra', order: 200, text: 'Extra guidance.' })
      try {
        const sections = await ctx.systemPrompt.sectionTexts(dir)
        const identity = sections.find(section => section.name === 'harness:identity')
        const extra = sections.find(section => section.name === 'plugin:extra')
        expect(identity).toMatchObject({ en: IDENTITY, zh: '中文身份。', editable: true })
        expect(sections.find(section => section.name === 'z-late'))
          .toMatchObject({ en: 'Late source.', zh: '中文早期。', editable: true })
        expect(sections.find(section => section.name === 'a-early'))
          .toMatchObject({ en: 'Early source.', zh: '中文后期。', editable: true })
        expect(extra).toMatchObject({ en: 'Extra guidance.', zh: '中文额外指引。', editable: true })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('projects a section\'s declared sub-subjects so one section can become several rows', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      // 一个 MCP 服务器：提示词里只有一节，但它的每个工具在反思文档里各占一格。
      ctx.systemPrompt.section({
        name: 'mcp:github',
        order: 200,
        text: 'Github is connected.',
        subjects: () => ['mcp__github__search', 'mcp__github__create_issue'],
      })
      // 声明本身会炸的分段（工具还没同步出来）不该把整次投影带下去。
      ctx.systemPrompt.section({
        name: 'mcp:flaky',
        order: 200,
        text: 'Flaky is connected.',
        subjects: () => { throw new Error('no tools yet') },
      })

      const sections = await ctx.systemPrompt.sectionTexts()

      expect(sections.find(section => section.name === 'mcp:github')?.subjects)
        .toEqual(['mcp__github__search', 'mcp__github__create_issue'])
      // 没声明过的分段是空数组，不是缺字段——界面据此判定"这一节只有它自己一行"。
      expect(sections.find(section => section.name === 'harness:identity')?.subjects).toEqual([])
      expect(sections.find(section => section.name === 'mcp:flaky')?.subjects).toEqual([])
    })

    it('lets an explicit completePromptFile override the per-session translation', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-explicit-complete-prompt-'))
      await mkdir(join(dir, '.dsh'), { recursive: true })
      await writeFile(join(dir, '.dsh', 'system-prompt.zh.prompt.md'), '自动翻译。', 'utf8')
      const explicit = join(dir, 'explicit.prompt.md')
      await writeFile(explicit, '显式完整提示词。', 'utf8')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { completePromptFile: explicit })
      try {
        const assembly = await ctx.systemPrompt.assemble({ cwd: dir })
        expect(assembly.sections.map(section => section.name)).toEqual(['deployment:complete-prompt'])
        expect(renderPrompt(assembly)).toBe('显式完整提示词。')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('applies a UI section override in place while preserving the section name', async () => {
      const ctx = new Context()
      const settings = {
        installSection: (
          _owner: unknown,
          _ns: string,
          _schema: unknown,
          _entry: unknown,
          hooks: {
            setSource: (current: () => PromptOverridesSettings) => void
            onChange: () => void
          },
        ) => {
          hooks.setSource(() => ({
            sectionCatalog: [],
            sections: { 'plugin:extra': { zh: '中文覆盖。', en: 'English override.' } },
          }))
          hooks.onChange()
        },
      }
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.installOverrides(ctx, settings)
      ctx.systemPrompt.section({ name: 'plugin:extra', order: 200, text: 'English guidance.' })

      // 替换文本的语言不由覆盖自己携带，而由本次装配的语言决定——没有语言来源
      // 时是内置英文，界面语言写成中文时就换成中文那一栏。
      ctx.systemPrompt.adoptLocaleSource(() => 'en')
      const english = await ctx.systemPrompt.assemble()
      expect(english.sections.map(section => section.name)).toContain('plugin:extra')
      expect(english.sections.find(section => section.name === 'plugin:extra')?.text).toBe('English override.')

      ctx.systemPrompt.adoptLocaleSource(() => 'zh')
      const chinese = await ctx.systemPrompt.assemble()
      expect(chinese.sections.find(section => section.name === 'plugin:extra')?.text).toBe('中文覆盖。')
    })

    it('keeps a section override when the section registered no text of its own', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.adoptLocaleSource(() => 'en')
      // `mcp:<server>` 注册文本是空的，覆盖就是它的全部内容——正是这条判空的
      // 顺序要保护的情形。
      ctx.systemPrompt.section({ name: 'mcp:demo', order: ctx.systemPrompt.getSectionOrder('MCP_INTRO'), text: '' })
      ctx.systemPrompt.installOverrides(ctx, {
        installSection: (
          _owner: unknown,
          _ns: string,
          _schema: unknown,
          _entry: unknown,
          hooks: {
            setSource: (current: () => PromptOverridesSettings) => void
            onChange: () => void
          },
        ) => {
          hooks.setSource(() => ({
            sectionCatalog: [],
            sections: { 'mcp:demo': { zh: '', en: 'MCP servers expose tools.' } },
          }))
          hooks.onChange()
        },
      })

      // 可选分段的判空排在覆盖之后：`mcp:demo` 自己不带文本，覆盖就是它的全部
      // 内容。判空先跑会把用户刚写好的一节静默丢掉。
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(section => section.name === 'mcp:demo')?.text)
        .toBe('MCP servers expose tools.')

      // 覆盖清空之后，这一节作为"没有话要说"整段消失，而不是留一个空壳。
      ctx.systemPrompt.installOverrides(ctx, {
        installSection: (
          _owner: unknown,
          _ns: string,
          _schema: unknown,
          _entry: unknown,
          hooks: {
            setSource: (current: () => PromptOverridesSettings) => void
            onChange: () => void
          },
        ) => {
          hooks.setSource(() => ({ sectionCatalog: [], sections: {} }))
          hooks.onChange()
        },
      })
      const emptied = await ctx.systemPrompt.assemble()
      expect(emptied.sections.map(section => section.name)).not.toContain('mcp:demo')
    })
  })

  describe('reflection sources', () => {
    it('appends a source\'s text below the section it names', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'tool:read', order: 10, text: 'Use the read tool.' })
      ctx.systemPrompt.section({ name: 'tool:write', order: 11, text: 'Use the write tool.' })
      ctx.systemPrompt.reflectionSource(name =>
        name === 'tool:read' ? '别忘了 read 要先看行数。' : undefined)

      const assembly = await ctx.systemPrompt.assemble()
      const read = assembly.sections.find(section => section.name === 'tool:read')?.text
      const write = assembly.sections.find(section => section.name === 'tool:write')?.text
      // 介绍在前、经验在后——追加而不是替换，用户润色过的措辞不会被吞掉。
      expect(read).toBe('Use the read tool.\n\n别忘了 read 要先看行数。')
      expect(write).toBe('Use the write tool.')
    })

    it('never resurrects a section whose own text is blank', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      // 分段存在、但它自己没话可说：`computer:policy` 由 tool-computer-use
      // 在启用时才注册，这里手工造出"注册了却空着"的形态来钉住判空这一层。
      ctx.systemPrompt.section({ name: 'computer:policy', order: 1, text: '' })
      ctx.systemPrompt.reflectionSource(name => name === 'computer:policy'
        ? '上次点错了坐标。'
        : undefined)

      const assembly = await ctx.systemPrompt.assemble()
      // 文档里还留着旧经验，不等于这项能力这一轮又回来了。
      expect(assembly.sections.map(section => section.name)).not.toContain('computer:policy')
    })

    it('stops contributing once the source is disposed', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'tool:read', order: 10, text: 'Use the read tool.' })
      const dispose = ctx.systemPrompt.reflectionSource(() => '先看行数。')
      expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:read')?.text)
        .toBe('Use the read tool.\n\n先看行数。')

      dispose()
      expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:read')?.text)
        .toBe('Use the read tool.')
    })
  })

  describe('prompt locale', () => {
    it('normalizes interface language tags onto the two prompt languages', () => {
      expect(normalizePromptLocale('zh')).toBe('zh')
      expect(normalizePromptLocale('zh-CN')).toBe('zh')
      expect(normalizePromptLocale('zh-Hans-CN')).toBe('zh')
      expect(normalizePromptLocale('ZH')).toBe('zh')
      expect(normalizePromptLocale('en')).toBe('en')
      expect(normalizePromptLocale('en-US')).toBe('en')
      expect(normalizePromptLocale('fr')).toBe('en')
      expect(normalizePromptLocale('')).toBe('en')
      expect(normalizePromptLocale(undefined)).toBe('en')
    })

    it('follows the adopted locale source while the locale is auto', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      // A deployment with no settings service keeps the built-in English copy.
      expect(ctx.systemPrompt.activeLocale()).toBe('en')
      ctx.systemPrompt.adoptLocaleSource(() => 'zh-CN')
      expect(ctx.systemPrompt.activeLocale()).toBe('zh')
      ctx.systemPrompt.adoptLocaleSource(() => undefined)
      expect(ctx.systemPrompt.activeLocale()).toBe('en')
    })

    it('lets a pinned promptLocale outrank the interface language', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'en' })
      ctx.systemPrompt.adoptLocaleSource(() => 'zh')
      expect(ctx.systemPrompt.activeLocale()).toBe('en')
    })

    it('hands one resolved locale to every section and context provider', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      const seen: Array<string | undefined> = []
      ctx.systemPrompt.section({
        name: 'probe', order: 1,
        text: (context) => { seen.push(context.locale); return 'x' },
      })
      ctx.systemPrompt.context({
        name: 'probe-ctx', order: 1,
        text: (context) => { seen.push(context.locale); return 'y' },
      })
      await ctx.systemPrompt.assemble()
      expect(seen).toEqual(['zh', 'zh'])
    })

    it('renders a first-party section in the assembly language', async () => {
      const zh = new Context()
      await zh.plugin(SystemPrompt, { promptLocale: 'zh' })
      expect((await zh.systemPrompt.assemble()).sections
        .find(section => section.name === 'harness:identity')?.text)
        .toBe(LOCALIZED_SECTIONS['harness:identity']?.zh?.text)

      const en = new Context()
      await en.plugin(SystemPrompt)
      expect((await en.systemPrompt.assemble()).sections
        .find(section => section.name === 'harness:identity')?.text)
        .toBe(IDENTITY)
    })

    it('never fills a section its provider left empty', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      // A section the owning plugin blanked means "not available now"; turning
      // it back into prose would announce a capability that is not mounted.
      ctx.systemPrompt.section({ name: 'tool:bash', order: 1, text: '' })
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(section => section.name === 'tool:bash')?.text).toBe('')
    })

    it('leaves dynamic sections to their providers', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      ctx.systemPrompt.section({ name: 'deployment:error-lessons', order: 1, text: () => 'live lessons' })
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find(section => section.name === 'deployment:error-lessons')?.text).toBe('live lessons')
    })

    it('carries runtime fragments from the original into the translation', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      ctx.systemPrompt.section({
        name: 'harness:source',
        order: 1,
        text: 'The DeepSeek Harness implementation checkout is at /srv/dsh. '
          + 'The checkout location and current working directory are separate values.',
      })
      const text = (await ctx.systemPrompt.assemble()).sections
        .find(section => section.name === 'harness:source')?.text ?? ''
      expect(text).toContain('/srv/dsh')
      expect(text).not.toContain('The DeepSeek Harness implementation')
    })

    it('keeps the original when the runtime fragment cannot be extracted', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      const original = 'Checkout lives somewhere else entirely.'
      ctx.systemPrompt.section({ name: 'harness:source', order: 1, text: original })
      // Losing the path would be worse than leaving this one section in English.
      expect((await ctx.systemPrompt.assemble()).sections
        .find(section => section.name === 'harness:source')?.text).toBe(original)
    })

    it('translates the standard persona as two sections, so the working directory is stated once', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, {
        promptLocale: 'zh',
        // 四个 bundle 的 cordis.patch.yml 都写这一对模板；它们各占一节，译文也必须
        // 各占一条。曾把后缀并进前缀那条译文里，于是中文提示词里工作目录出现两次，
        // 而末尾还留着一句英文原文。
        personaPrefix: 'You are a coding agent powered by the {{model}} model.',
        personaSuffix: 'Your working directory is {{cwd}}.',
      })
      ctx.systemPrompt.variable('model', () => 'glm-5.3-flash')
      ctx.systemPrompt.variable('cwd', () => 'D:/ws')
      const rendered = renderPrompt(await ctx.systemPrompt.assemble())
      expect(rendered).toContain('你是由 glm-5.3-flash 模型驱动的编码智能体。')
      expect(rendered).toContain('当前工作目录是 D:/ws。')
      expect(rendered.match(/D:\/ws/gu)).toHaveLength(1)
      expect(rendered).not.toContain('Your working directory')
    })

    it('carries the live server names into the translated resource list', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { promptLocale: 'zh' })
      ctx.systemPrompt.section({
        name: 'mcp-resource-servers',
        order: 1,
        interpolate: false,
        text: '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, '
          + 'or read_mcp_resource with one of these names as the server argument: ["codegraph"].',
      })
      const text = (await ctx.systemPrompt.assemble()).sections
        .find(section => section.name === 'mcp-resource-servers')?.text ?? ''
      // 服务器名是运行期事实：译文留着旧名字比留着英文更糟。
      expect(text).toContain('["codegraph"]')
      expect(text).not.toContain('MCP resource servers')
    })

    it('translates the PTC-only rule with the interface language', async () => {
      const render = async (promptLocale: 'zh' | 'en'): Promise<string> => {
        const ctx = new Context()
        try {
          await ctx.plugin(SystemPrompt, { promptLocale })
          // The shape the registry registers: the text is empty unless the
          // effective mode is `ptc`, and the section is registered for `both`.
          ctx.systemPrompt.section({
            name: 'tools:ptc-only',
            order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
            text: '`run_code` is the only tool you can call directly — a tool call naming any other tool fails. '
              + 'Reach every tool the SDK declares below from inside the program.',
          })
          return (await ctx.systemPrompt.assemble()).sections
            .find(section => section.name === 'tools:ptc-only')?.text ?? ''
        } finally {
          await ctx.fiber.dispose()
        }
      }

      expect(await render('zh')).toBe(LOCALIZED_SECTIONS['tools:ptc-only']?.zh?.text)
      expect(await render('en')).toContain('is the only tool you can call directly')
    })

    it('translates plan guidance only while it is still the first-party template', () => {
      const canonical = 'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user '
        + 'switches the session mode. The tool catalog stays the same across modes for request-cache stability; '
        + 'those tools remain listed only to keep the request shape stable. do not proceed with implementation.'
      // 预设那份抄写与插件内置默认已经漂移：只差中间一句话，仍算同一份模板——译文要能
      // 同时覆盖两种写法，否则中文部署读到的是一句中文都没有的策略。
      const drifted = canonical.replace('only to keep the request shape stable', 'to keep the tool catalog unchanged')

      expect(localizedSectionText('plan:policy', canonical, 'zh')).toContain('你正处于计划模式')
      expect(localizedSectionText('plan:policy', `${drifted}\n`, 'zh')).toContain('你正处于计划模式')
      // 部署在后面追加自己的段落＝那是别人的策略：抽不出来就整段让路，替人改主意比留英文更糟。
      expect(localizedSectionText('plan:policy', `${canonical}\n\nAlso ping #plan-review first.`, 'zh')).toBeUndefined()
      expect(localizedSectionText('plan:policy', 'Plan first, then build.', 'zh')).toBeUndefined()
    })

    it('keeps the generated SDK out of the static asset, because its body is computed', () => {
      // `tools:sdk` 的正文按调用方作用域的可见工具集现算，正是这张表不收的那一类
      // （"内容静态"）。所以它由渲染器按装配语言自行选散文；这里钉住"没有第二条
      // 写入路径"——一条 `tools:sdk` 条目会盖掉渲染器刚选好的语言，并且只保得住
      // 声明块、保不住 `renderBashExample` 那一段。
      expect(LOCALIZED_SECTIONS['tools:sdk']).toBeUndefined()
    })

    it('ships a translation for every section it names, in both directions where needed', () => {
      expect(localizedSectionNames().length).toBeGreaterThan(10)
      for (const name of localizedSectionNames()) {
        const entry = LOCALIZED_SECTIONS[name]
        expect(entry).toBeDefined()
        for (const [locale, value] of Object.entries(entry ?? {})) {
          expect(['zh', 'en']).toContain(locale)
          expect(value?.text.trim()).not.toBe('')
        }
      }
    })

    it('ignores the Chinese translation archive under the English locale', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-locale-archive-'))
      try {
        await mkdir(join(dir, '.dsh'), { recursive: true })
        await writeFile(join(dir, '.dsh', 'system-prompt.zh.prompt.md'), '中文身份。', 'utf8')
        const en = new Context()
        await en.plugin(SystemPrompt)
        expect(renderPrompt(await en.systemPrompt.assemble({ cwd: dir }))).toBe(IDENTITY)

        const zh = new Context()
        await zh.plugin(SystemPrompt, { promptLocale: 'zh' })
        expect(renderPrompt(await zh.systemPrompt.assemble({ cwd: dir }))).toBe('中文身份。')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('drops an empty optional section but keeps an empty ordinary one', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'computer:policy', order: 1, text: '' })
      ctx.systemPrompt.section({ name: 'mcp:demo', order: 2, text: '' })
      ctx.systemPrompt.section({ name: 'tool:subagent', order: 3, text: '' })
      const names = (await ctx.systemPrompt.assemble()).sections.map(section => section.name)
      expect(names).not.toContain('computer:policy')
      // Each mounted MCP server registers an `mcp:<server>` section; one that has
      // nothing to say (no introspection and no lessons) must not leave a hole.
      expect(names).not.toContain('mcp:demo')
      // "Registered but silent" is a real state that consumers distinguish from
      // "not mounted"; only the optional families may vanish.
      expect(names).toContain('tool:subagent')
    })

    it('withholds the computer-use policy from the editable section list', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      ctx.systemPrompt.section({ name: 'computer:policy', order: 1, text: 'Touch the screen carefully.' })

      const policy = (await ctx.systemPrompt.sectionTexts())
        .find(row => row.name === 'computer:policy')

      // 它的正文是部署给出的安全边界（屏幕内容是证据不是指令、不可逆操作先问用户），
      // 不是一个可供润色的输入框；经验那一栏才是让用户写的地方。
      expect(policy?.editable).toBe(false)
      expect(policy?.en).toBe('')
    })

    it('places the computer-use policy beside the MCP intro, not at the top', () => {
      const service = new SystemPrompt(new Context(), {})
      const mcpIntro = service.getSectionOrder('MCP_INTRO')
      const computer = service.getSectionOrder('COMPUTER_USE_POLICY')
      const lessons = service.getSectionOrder('ERROR_LESSONS')
      expect(computer).toBeGreaterThan(mcpIntro)
      expect(computer).toBeLessThan(lessons)
    })
  })

  describe('locale settings bridge', () => {
    function settingsWith(locale: unknown) {
      return {
        installSection: (
          _owner: unknown, _ns: string, _schema: unknown, _entry: unknown,
          hooks: { setSource: (current: () => unknown) => void; onChange: () => void },
        ) => {
          hooks.setSource(() => ({
            active: 'zh', sectionCatalog: [], sections: {}, mcpIntro: { zh: '', en: '' },
          }))
          hooks.onChange()
        },
        get: (ns: string) => (ns === 'locale' ? locale : undefined),
      }
    }

    it('reads the interface language out of the settings document', () => {
      const settings = settingsWith({ preference: 'zh' }) as never
      expect(readLocalePreference(settings, 'locale', 'preference')).toBe('zh')
      expect(readLocalePreference(settings, 'other', 'preference')).toBeUndefined()
    })

    it('treats an unreadable language as absent instead of failing', () => {
      const settings = settingsWith(undefined) as never
      expect(readLocalePreference(settings, 'locale', 'preference')).toBeUndefined()
      const malformed = settingsWith({ preference: 7 }) as never
      expect(readLocalePreference(malformed, 'locale', 'preference')).toBeUndefined()
    })

    it('drives assembly language from the stored interface language', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      Object.defineProperty(ctx, 'settings', { value: settingsWith({ preference: 'zh-CN' }) })
      applyOverrides(ctx)
      expect(ctx.systemPrompt.activeLocale()).toBe('zh')
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.locale).toBe('zh')
      expect(assembly.sections.find(section => section.name === 'harness:identity')?.text)
        .toBe(LOCALIZED_SECTIONS['harness:identity']?.zh?.text)
    })
  })
})
