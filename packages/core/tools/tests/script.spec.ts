/**
 * Covers the generic `script` entry: the grammar, the whole-script-first refusal,
 * the per-line nested dispatch, and the two consequences the row derives from a
 * capability's contribution — the withheld schemas and the refusal of a
 * model-direct call to one.
 *
 * The verbs here are SYNTHETIC on purpose. The point of this file is that the
 * entry knows nothing about the capability that fills it: a contribution brings
 * its own verb table, and the row turns it into a resident schema, a withholding,
 * and a guard without being told what any of it means. The computer package's own
 * test file guards the direction this one cannot — that ITS verb table still
 * matches the action declarations it dispatches to.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ScriptContribution, ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as ToolScript from '@deepseek-ai/dsh-tools/script'
import type { ScriptParseContext } from '@deepseek-ai/dsh-tools/script'
import { SCRIPT_TOOL_NAME, parseScript, readScriptParameters } from '@deepseek-ai/dsh-tools/script'

const testToolSignal = new AbortController().signal

/** Every action the fixtures ran, in order — the seam the script layer is judged by. */
const ran: Array<{ name: string; args: Record<string, unknown> }> = []

/** A registry-ready fixture whose parameter TYPES are the point: the parser reads them. */
function fixture(
  name: string,
  properties: Record<string, string>,
  required: readonly string[] = [],
): ToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, { type }])),
      required: [...required],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (args) => {
      ran.push({ name, args: { ...args as Record<string, unknown> } })
      if (name === 'fx_explode') throw new Error('boom')
      return Promise.resolve(`ran:${name}`)
    },
  }
}

/** Five shapes between them: no argument, two integers, a string, a list, a boolean. */
function registerFixtures(ctx: Context): void {
  ctx.tools.register(fixture('fx_ping', {}))
  ctx.tools.register(fixture('fx_move', { x: 'integer', y: 'integer' }, ['x', 'y']))
  ctx.tools.register(fixture('fx_label', { text: 'string' }, ['text']))
  ctx.tools.register(fixture('fx_chord', { keys: 'array' }, ['keys']))
  ctx.tools.register(fixture('fx_toggle', { on: 'boolean' }, ['on']))
  ctx.tools.register(fixture('fx_explode', {}))
}

/** The contributed surface: five verbs, and every target but the no-argument one withheld. */
const FIXTURE_CONTRIBUTION: ScriptContribution = {
  id: 'fixture',
  verbs: {
    ping: { tool: 'fx_ping', positional: [] },
    move: { tool: 'fx_move', positional: ['x', 'y'] },
    label: { tool: 'fx_label', positional: ['text'] },
    chord: { tool: 'fx_chord', positional: ['keys'] },
    toggle: { tool: 'fx_toggle', positional: ['on'] },
    explode: { tool: 'fx_explode', positional: [] },
  },
  withheld: ['fx_move', 'fx_label', 'fx_chord', 'fx_toggle', 'fx_explode'],
}

/**
 * @param options - `contribute: false` mounts the row with nothing to contribute
 *   (the deployment-before-a-capability case); `row: false` mounts no row at all.
 */
async function harness(options: { contribute?: boolean; row?: boolean } = {}): Promise<Context> {
  ran.length = 0
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerFixtures(ctx)
  if (options.contribute !== false) ctx.tools.contributeScript(FIXTURE_CONTRIBUTION)
  if (options.row !== false) await ctx.plugin(ToolScript)
  return ctx
}

/** The wire tool names, i.e. what a request would actually declare. */
async function wireNames(ctx: Context): Promise<string[]> {
  return (await ctx.systemPrompt.assemble({})).tools.map(tool => tool.name)
}

/** The parse context the row hands the parser: the merged table plus the live declarations. */
function parseContext(ctx: Context): ScriptParseContext {
  return {
    verbs: ctx.tools.scriptSurface().verbs,
    parametersOf: (tool) => {
      const declared = ctx.tools.get(tool)?.parameters
      return declared === undefined ? undefined : readScriptParameters(declared)
    },
  }
}

/** Arguments of the single action a one-line script parses to. */
function argsOf(ctx: Context, code: string): Readonly<Record<string, unknown>> {
  const steps = parseScript(code, parseContext(ctx))
  expect(steps).toHaveLength(1)
  return steps[0]!.args
}

/** Run one script through the registry and return the whole result. */
async function runScript(ctx: Context, code: string): ReturnType<Context['tools']['execute']> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name: SCRIPT_TOOL_NAME,
    arguments: { code },
  })
}

describe('script: shaping a line', () => {
  it('binds positional arguments in the verb\'s declared order', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'move 100 200')).toEqual({ x: 100, y: 200 })
  })

  it('parses a verb that takes no argument', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'ping')).toEqual({})
  })

  it('binds named arguments by name, and mixes them with positional ones', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'move y=200 x=100')).toEqual({ x: 100, y: 200 })
    expect(argsOf(ctx, 'label hello')).toEqual({ text: 'hello' })
  })

  it('keeps spaces and resolves escapes inside double quotes', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'label "hello world"')).toEqual({ text: 'hello world' })
    expect(argsOf(ctx, 'label "line1\\nline2\\ttab"')).toEqual({ text: 'line1\nline2\ttab' })
    expect(argsOf(ctx, 'label "a \\"quoted\\" word"')).toEqual({ text: 'a "quoted" word' })
    // Outside quotes nothing is an escape sequence: `\n` is two characters.
    expect(argsOf(ctx, 'label hello\\nworld')).toEqual({ text: 'hello\\nworld' })
  })

  it('coerces numbers, lists, and booleans from the target\'s own declarations', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'chord ctrl,shift,s')).toEqual({ keys: ['ctrl', 'shift', 's'] })
    expect(argsOf(ctx, 'toggle true')).toEqual({ on: true })
    expect(argsOf(ctx, 'move -120 40')).toEqual({ x: -120, y: 40 })
  })

  it('ignores comments and blank lines but keeps the script\'s real line numbers', async () => {
    const ctx = await harness()
    const steps = parseScript([
      '# first look at the screen',
      '',
      'ping',
      '   ',
      'move 10 20   # the top left corner',
    ].join('\n'), parseContext(ctx))
    expect(steps.map(step => [step.line, step.verb])).toEqual([[3, 'ping'], [5, 'move']])
    expect(steps.map(step => step.source)).toEqual(['ping', 'move 10 20'])
  })

  it('does not read `#` inside quotes as a comment', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'label "tag #1"')).toEqual({ text: 'tag #1' })
  })

  it('does not read a value containing `=` as a named argument (`a` is not a parameter)', async () => {
    const ctx = await harness()
    expect(argsOf(ctx, 'label a=b')).toEqual({ text: 'a=b' })
  })
})

describe('script: refusing a line', () => {
  it('names the line and the available verbs for an unknown action', async () => {
    const ctx = await harness()
    expect(() => parseScript('ping\npign 1 2', parseContext(ctx)))
      .toThrowError(/line 2: unknown action `pign`; available: /)
  })

  it('names the line and the available parameters for an unknown parameter', async () => {
    const ctx = await harness()
    expect(() => parseScript('move 1 2 xX=3', parseContext(ctx)))
      .toThrowError(/line 1: `move` has no parameter `xX`; available: x, y/)
  })

  it('refuses a missing required parameter', async () => {
    const ctx = await harness()
    expect(() => parseScript('move 100', parseContext(ctx)))
      .toThrowError(/line 1: `move` is missing required parameter `y`/)
  })

  it('refuses too many positional arguments', async () => {
    const ctx = await harness()
    expect(() => parseScript('move 1 2 3', parseContext(ctx)))
      .toThrowError(/line 1: `move` takes at most 2 positional argument\(s\)/)
  })

  it('refuses the same parameter twice', async () => {
    const ctx = await harness()
    expect(() => parseScript('move 1 2 x=3', parseContext(ctx)))
      .toThrowError(/line 1: parameter `x` was given twice/)
  })

  it('refuses a non-numeric value for a numeric parameter', async () => {
    const ctx = await harness()
    expect(() => parseScript('move abc 200', parseContext(ctx)))
      .toThrowError(/line 1: parameter `x` needs a number, got `abc`/)
  })

  it('refuses a value that is neither true nor false', async () => {
    const ctx = await harness()
    expect(() => parseScript('toggle yes', parseContext(ctx)))
      .toThrowError(/line 1: parameter `on` needs true or false, got `yes`/)
  })

  it('refuses an unterminated quote, with its line number', async () => {
    const ctx = await harness()
    expect(() => parseScript('ping\nlabel "unterminated', parseContext(ctx)))
      .toThrowError(/line 2: unterminated double quote/)
  })

  it('refuses a script with no action at all', async () => {
    const ctx = await harness()
    expect(() => parseScript('\n# only a comment\n', parseContext(ctx)))
      .toThrowError(/the script has no actions/)
  })

  it('refuses a verb whose target is not registered in this scope', async () => {
    // The capability is off, or this host has no implementation: the target tool
    // is simply absent from the registry, and the whole script is refused before
    // any line runs.
    const ctx = await harness({ contribute: false, row: false })
    ctx.tools.contributeScript({ id: 'alone', verbs: { move: { tool: 'fx_missing', positional: [] } } })
    expect(() => parseScript('move', parseContext(ctx)))
      .toThrowError(/line 1: `move` is not available/)
  })

  it('refuses any script when no capability contributed a verb at all', async () => {
    const ctx = await harness({ contribute: false, row: false })
    expect(() => parseScript('ping', parseContext(ctx)))
      .toThrowError(/no actions are available/)
  })
})

describe('script: the row derives everything from the contribution', () => {
  it('registers nothing when no capability contributed a verb table', async () => {
    const ctx = await harness({ contribute: false })
    expect(ctx.tools.get(SCRIPT_TOOL_NAME)).toBeUndefined()
    expect(await wireNames(ctx)).toEqual([
      'fx_chord', 'fx_explode', 'fx_label', 'fx_move', 'fx_ping', 'fx_toggle',
    ])
  })

  it('puts the entry on the wire and keeps every withheld name off it, still registered', async () => {
    const ctx = await harness()
    const names = await wireNames(ctx)
    expect(names).toContain(SCRIPT_TOOL_NAME)
    for (const name of FIXTURE_CONTRIBUTION.withheld ?? []) expect(names).not.toContain(name)
    // Withheld is not unregistered: the script dispatches through the registry, so
    // the definition has to stay there.
    expect(ctx.tools.get('fx_move')).toBeDefined()
    expect(ctx.tools.deferredTools().map(tool => tool.definition.name))
      .toEqual([...FIXTURE_CONTRIBUTION.withheld ?? []].sort())
  })

  it('refuses a model-direct call to a withheld name, naming the line to write instead', async () => {
    const ctx = await harness()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('direct'),
      name: 'fx_move',
      arguments: { x: 1, y: 2 },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cannot be called directly')
    expect(JSON.stringify(result.content)).toContain('write it as the line `move`')
    expect(ran).toEqual([])
  })

  it('reaches the same withheld name from inside a script', async () => {
    const ctx = await harness()
    const result = await runScript(ctx, 'move 100 200')
    expect(result.isError).toBe(false)
    // The script's own result carries each action's receipt plus a summary line.
    expect(result.content).toEqual([
      { type: 'text', text: 'ran:fx_move' },
      { type: 'text', text: 'Script finished: all 1 action(s) took effect.' },
    ])
    expect(ran).toEqual([{ name: 'fx_move', args: { x: 100, y: 200 } }])
  })

  it('runs the lines in order and stops at the first failure', async () => {
    const ctx = await harness()
    const result = await runScript(ctx, 'ping\nexplode\nping')
    expect(ran.map(call => call.name)).toEqual(['fx_ping', 'fx_explode'])
    expect(result.value).toMatchObject({ failedAt: 2 })
    expect(JSON.stringify(result.content)).toContain('failed at line 2')
  })

  it('refuses the whole script before running anything when one line is wrong', async () => {
    const ctx = await harness()
    const result = await runScript(ctx, 'ping\npign')
    expect(result.isError).toBe(true)
    expect(ran).toEqual([])
  })

  it('refuses a second contribution under an id already taken', async () => {
    const ctx = await harness()
    expect(() => ctx.tools.contributeScript({ id: 'fixture', verbs: {} }))
      .toThrowError(/contribution "fixture" is already registered/)
  })

  it('refuses a verb another contribution already owns', async () => {
    const ctx = await harness()
    expect(() => ctx.tools.contributeScript({ id: 'second', verbs: { move: { tool: 'fx_other', positional: [] } } }))
      .toThrowError(/verb "move" is already contributed by "fixture"/)
  })

  it('withdraws a contribution in full', async () => {
    const ctx = await harness({ row: false })
    const dispose = ctx.tools.contributeScript({ id: 'extra', verbs: { extra: { tool: 'fx_ping', positional: [] } } })
    expect(Object.keys(ctx.tools.scriptSurface().verbs)).toContain('extra')
    expect(ctx.tools.scriptSurface().withheld.size).toBe(FIXTURE_CONTRIBUTION.withheld?.length)
    dispose()
    expect(Object.keys(ctx.tools.scriptSurface().verbs)).not.toContain('extra')
  })
})
