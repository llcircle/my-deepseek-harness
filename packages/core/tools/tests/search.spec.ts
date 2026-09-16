/**
 * Covers the on-demand half of the tool catalog: `defer` narrows the WIRE,
 * `tool_search` widens it back per agent, and dispatch is never narrowed at
 * all. The invariants worth pinning are the ones a "hide it" feature usually
 * breaks — a withheld tool must stay callable, a fetch must not leak to a
 * sibling agent, and the index must stop naming what is already loaded.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolSearch from '@deepseek-ai/dsh-tools/search'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

const testToolSignal = new AbortController().signal

async function setup(config: ToolSearch.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolSearch, config)
  return ctx
}

/**
 * Mint a scope whose key doubles as a minimal Agent-like object. The key object
 * must be the SAME identity the layer store was given, so the scoped context is
 * attached to it rather than wrapped beside it.
 * @param ctx - the mounting context.
 * @param name - scope identity.
 * @param parent - an enclosing scope key, for a preset standing mount.
 * @returns the scope plus its Agent-like key.
 */
async function mintScope(ctx: Context, name: string, parent?: ScopeKey): Promise<{ scope: Scope; agent: Agent }> {
  const key = { id: name as SessionId } as Agent & { ctx?: Context }
  let scope!: Scope
  await ctx.plugin(Object.assign(
    (inner: Context) => {
      scope = createScope(inner, key, parent === undefined ? undefined : { parent })
      ;(key as { ctx?: Context }).ctx = scope.ctx
    },
    { inject: ['tools', 'systemPrompt'] },
  ))
  return { scope, agent: key }
}

/** A registry-ready fixture whose parameter names are searchable. */
function fixture(name: string, description: string, properties: Record<string, string> = {}): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties)
        .map(([key, text]) => [key, { type: 'string', description: text }])),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

/** Register the fixture set every case draws from. */
function registerCatalog(ctx: Context): void {
  ctx.tools.register(fixture('read', 'Read a file from the workspace.'))
  ctx.tools.register(fixture('web_fetch', 'Fetch a URL and return its text.', { url: 'The URL to fetch' }))
  ctx.tools.register(fixture('web_search', 'Search the web for current information.', { query: 'Search terms' }))
  ctx.tools.register(fixture('job', 'Collect or stop a background job.', { action: 'list, output, or kill' }))
}

/** The wire tool names one scope is shown; omitted reads the deployment default. */
async function wireNames(ctx: Context, scope?: ScopeKey): Promise<string[]> {
  return (await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })).tools.map(tool => tool.name)
}

/** The on-demand index section text one scope sees. */
async function indexText(ctx: Context, scope: ScopeKey): Promise<string> {
  return (await ctx.systemPrompt.assemble({ scope })).sections
    .find(section => section.name === ToolSearch.ON_DEMAND_SECTION)?.text ?? ''
}

/** Run one tool and return the whole result, so error surfacing stays visible. */
async function invoke(ctx: Context, name: string, args: unknown, agent?: Agent): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Run one tool and return its first text block. */
async function call(ctx: Context, name: string, args: unknown, agent?: Agent): Promise<string> {
  const result = await invoke(ctx, name, args, agent)
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

describe('withholding an on-demand tool', () => {
  it('drops the schema from the wire while leaving the tool callable', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch', 'web_search', 'job'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    expect(await wireNames(ctx, agent.agent)).toEqual(['read', 'tool_search'])
    // The whole point: the name still resolves, because dispatch reads the
    // registry and only the request body was narrowed.
    expect(await call(ctx, 'web_fetch', {}, agent.agent)).toBe('ran:web_fetch')
    expect(ctx.tools.get('web_fetch', agent.agent)).toBeDefined()
  })

  it('is scoped: a sibling composition keeps the tool resident', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const lean = await mintScope(ctx, 'lean')
    lean.scope.ctx.tools.defer(['web_fetch'])
    const leanAgent = await mintScope(ctx, 'lean-agent', lean.agent)
    const other = await mintScope(ctx, 'other')

    expect(await wireNames(ctx, leanAgent.agent)).toEqual(['job', 'read', 'tool_search', 'web_search'])
    expect(await wireNames(ctx, other.agent)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
    // The deployment-global view is untouched by a scoped declaration.
    expect(await wireNames(ctx)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
  })

  it('ignores a name nothing registered, so a preset may defer a group it does not compose', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['workflow', 'ralph'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    expect(await wireNames(ctx, agent.agent)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
    expect(await indexText(ctx, agent.agent)).toBe('')
  })

  it('rejects a second declaration of the same name in one scope', async () => {
    const ctx = await setup()
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch'])
    expect(() => preset.scope.ctx.tools.defer(['web_fetch'])).toThrow(/already deferred in this scope/)
  })

  it('restores the schema when the declaration is disposed', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    const dispose = preset.scope.ctx.tools.defer(['web_fetch', 'web_search'])
    const agent = await mintScope(ctx, 'agent', preset.agent)
    expect(await wireNames(ctx, agent.agent)).toEqual(['job', 'read', 'tool_search'])

    dispose()
    expect(await wireNames(ctx, agent.agent)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
  })
})

describe('the on-demand index section', () => {
  it('names every withheld tool once, with a bounded hint from its description', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch', 'job'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    const text = await indexText(ctx, agent.agent)
    expect(text).toContain(`\`${ToolSearch.TOOL_SEARCH_NAME}\``)
    expect(text).toContain('On demand: job — Collect or stop a background job.')
    expect(text).toContain('web_fetch — Fetch a URL and return its text.')
    // `read` is resident, so the index must not advertise it.
    expect(text).not.toContain('read —')
  })

  it('renders nothing at all when the composition withholds nothing', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    expect(await indexText(ctx, (await mintScope(ctx, 'plain')).agent)).toBe('')
  })

  it('drops a name as soon as that agent fetches it', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch', 'job'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'web_fetch' }, agent.agent)
    const text = await indexText(ctx, agent.agent)
    expect(text).not.toContain('web_fetch —')
    expect(text).toContain('job —')
  })

  it('cuts a long hint on a word boundary rather than mid-word', async () => {
    const ctx = await setup({ hintChars: 12 })
    ctx.tools.register(fixture('verbose', 'word word word word word of it.'))
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['verbose'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    expect(await indexText(ctx, agent.agent)).toContain('verbose — word word…')
  })
})

describe('tool_search', () => {
  it('fetches a bare name and lands its full schema in the next request', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    const text = await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'web_fetch' }, agent.agent)
    expect(text).toContain('1 on-demand tool(s) matched "web_fetch"')
    expect(text).toContain('<function>{"name":"web_fetch"')
    expect(text).toContain('"url"')
    const assembled = await ctx.systemPrompt.assemble({ scope: agent.agent })
    expect(assembled.tools.map(tool => tool.name)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
    expect(assembled.tools.find(tool => tool.name === 'web_fetch')?.parameters).toBeDefined()
  })

  it('fetches every selected name and reports the ones that are not on demand', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch', 'web_search'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    const text = await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'select:web_fetch, web_search, read' }, agent.agent)
    expect(text).toContain('2 on-demand tool(s) matched')
    // A resident tool is not on demand, so naming it is a miss the model can see.
    expect(text).toContain('Not on demand: read.')
    expect(await wireNames(ctx, agent.agent)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
  })

  it('ranks a word-boundary keyword query and honours a +required term', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch', 'web_search'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    const both = await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'web' }, agent.agent)
    expect(both).toContain('"name":"web_fetch"')
    expect(both).toContain('"name":"web_search"')

    const one = await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: '+search web' }, agent.agent)
    expect(one).toContain('1 on-demand tool(s) matched')
    expect(one).not.toContain('"name":"web_fetch"')
  })

  it('answers a second fetch of the same tool without re-declaring it', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'web_fetch' }, agent.agent)
    const again = await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'select:web_fetch' }, agent.agent)
    expect(again).toContain('Already loaded: web_fetch.')
  })

  it('explains an empty result instead of returning nothing', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch', 'job'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    expect(await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'teleport' }, agent.agent))
      .toContain('2 tool(s) are on demand')
    const bare = await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: '' }, (await mintScope(ctx, 'loner')).agent)
    expect(bare).toContain('This agent holds no tools on demand.')
  })

  it('refuses a call with no calling agent', async () => {
    const ctx = await setup()
    const result = await invoke(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'web_fetch' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('requires a calling agent')
  })

  it('keeps one agent\'s fetch out of its sibling\'s catalog', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch'])
    const eager = await mintScope(ctx, 'eager', preset.agent)
    const frugal = await mintScope(ctx, 'frugal', preset.agent)

    await call(ctx, ToolSearch.TOOL_SEARCH_NAME, { query: 'web_fetch' }, eager.agent)
    expect(await wireNames(ctx, eager.agent)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
    expect(await wireNames(ctx, frugal.agent)).toEqual(['job', 'read', 'tool_search', 'web_search'])
  })
})

describe('deferredTools', () => {
  it('reports the declared set with its load state, in name order', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_search', 'job'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    expect(ctx.tools.deferredTools(agent.agent)
      .map(entry => [entry.definition.name, entry.loaded])).toEqual([['job', false], ['web_search', false]])
    agent.scope.ctx.tools.loadDeferred(['job'])
    expect(ctx.tools.deferredTools(agent.agent).map(entry => [entry.definition.name, entry.loaded]))
      .toEqual([['job', true], ['web_search', false]])
  })

  it('omits a declared name this scope cannot see', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch'])
    const agent = await mintScope(ctx, 'agent', preset.agent)
    agent.scope.ctx.tools.restrict({ deny: ['web_fetch'] })

    expect(ctx.tools.deferredTools(agent.agent)).toEqual([])
    expect(await indexText(ctx, agent.agent)).toBe('')
  })

  it('re-withholds a fetched tool when the fetch is disposed', async () => {
    const ctx = await setup()
    registerCatalog(ctx)
    const preset = await mintScope(ctx, 'preset')
    preset.scope.ctx.tools.defer(['web_fetch'])
    const agent = await mintScope(ctx, 'agent', preset.agent)

    const release = agent.scope.ctx.tools.loadDeferred(['web_fetch'])
    expect(await wireNames(ctx, agent.agent)).toEqual(['job', 'read', 'tool_search', 'web_fetch', 'web_search'])
    release()
    expect(await wireNames(ctx, agent.agent)).toEqual(['job', 'read', 'tool_search', 'web_search'])
  })
})
