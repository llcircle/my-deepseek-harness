/**
 * MCP servers under PTC mode — the cross-cutting seam between the MCP bridge and
 * the `run_code` presentation.
 *
 * The MCP suite (`packages/mcp/mcp-client/tests/mcp-client.e2e.ts`) proves the
 * bridge against a real stdio server, but only ever in NATIVE mode, and the PTC
 * suite (`ptc.e2e.ts`) only ever dispatches first-party tools. Neither lane
 * would notice if a third-party server stopped reaching the generated SDK, and
 * the difference between the two modes is exactly where the tool-error journal
 * loses its subject — so this file drives BOTH modes against ONE fixture server
 * with a scripted model and asserts on the durable event stream.
 *
 * The two facts worth pinning, neither of which any other test covers:
 *
 * 1. An MCP tool is reachable from a PTC program, and a failing sub-call arrives
 *    in the program as a catchable typed `ToolCallError` carrying the public
 *    (server-qualified) tool name.
 * 2. A sub-call failure is logged as `tool/ptc-dispatch` and NOT as
 *    `tool/result`. The error journal only taps `tool/result`, so a program that
 *    catches its own failures — the whole point of the mode — leaves no journal
 *    entry at all, and the surviving entries name the transport (`run_code`)
 *    rather than the ability that actually broke. The native control turn at the
 *    top of this file records the `tool/result` the journal does see, so the
 *    contrast is asserted rather than assumed.
 */

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { Config as ToolRuntimeConfig } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'

/**
 * mcp-client's own stdio fixture server, reused rather than duplicated: the two
 * lanes must agree on what an MCP server does, and the child resolves the MCP
 * SDK from its own package directory.
 */
const FIXTURE_SERVER = fileURLToPath(new URL(
  '../../../../../../packages/mcp/mcp-client/tests/fixture-server.ts', import.meta.url,
))

const SERVER_NAME = 'fixture'

/** A sub-call failure that reaches the extension host — deliberately benign. */
const MCP_FAILURE_TEXT = 'Something went wrong'

/** The PTC program: one successful sub-call, then one failure it catches itself. */
const PROGRAM = `
  const sum = await tools.mcp__${SERVER_NAME}__add({ a: 2, b: 3 });
  let failure;
  try {
    await tools.mcp__${SERVER_NAME}__fail({});
  } catch (error) {
    failure = { name: error.name, toolName: error.toolName, message: error.message };
  }
  return { sum, failure };
`

/** One scripted model turn: a tool call, or the final answer. */
type ScriptStep =
  | { kind: 'call'; id: string; name: string; arguments: string }
  | { kind: 'stop'; text: string }

/** Deterministic keyless adapter: replays a fixed step list, one per model call. */
class ScriptedAdapter extends LlmAdapter {
  private index = 0

  constructor(private readonly steps: readonly ScriptStep[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.steps[this.index]
    this.index += 1
    if (step === undefined) throw new Error('scripted adapter: the model called more turns than the script has steps')
    if (step.kind === 'stop') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: step.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: step.name, argumentsDelta: step.arguments }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(step.id), name: step.name, arguments: step.arguments },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** Boot the smallest real tree that can run a turn in the requested presentation mode. */
async function harness(mode: NonNullable<ToolRuntimeConfig['mode']>, steps: readonly ScriptStep[]): Promise<Context> {
  const tree = new Context()
  await tree.plugin(LlmRuntime)
  await tree.plugin(SessionStore)
  await tree.plugin(SessionProjectionRegistry)
  await tree.plugin(SystemPrompt)
  await tree.plugin(ToolRuntime, { mode })
  await tree.plugin(AgentRegistry)
  await tree.plugin(AgentLoop, { agents: [] })
  await tree.plugin(LocalFileSystem)
  await tree.plugin(LocalSubprocessRuntime)
  await tree.plugin(Sandbox, {})
  await tree.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await tree.plugin(NodeRuntime, {})
  // Same adapter the shipped routes use; a mocked `llm` seam keeps the lane keyless.
  tree.llm.registerAdapter(['scripted'], new ScriptedAdapter(steps))
  await applyMcpClient(tree, {
    transport: 'stdio',
    serverName: SERVER_NAME,
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 15_000,
    failOnStartupError: true,
  } satisfies McpConfig)
  return tree
}

function waitForIdle(harness: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = harness.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Drive one turn and return the durable events it produced. */
async function driveTurn(harness: Context, agent: Agent, task: string): Promise<readonly SessionEvent[]> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await waitForIdle(harness, agent)
  return agent.session.snapshotEvents()
}

describe('MCP server under native mode — the control turn', () => {
  it('records a failed MCP call as a tool/result the error journal can see', async () => {
    ctx = await harness('native', [
      { kind: 'call', id: 'native-add', name: `mcp__${SERVER_NAME}__add`, arguments: '{"a":2,"b":3}' },
      { kind: 'call', id: 'native-fail', name: `mcp__${SERVER_NAME}__fail`, arguments: '{}' },
      { kind: 'stop', text: 'done' },
    ])
    const handle = await ctx.agents.create({
      sessionId: SessionId('mcp-native'),
      agentOptions: { provider: 'scripted', model: 'scripted' },
    })

    const events = await driveTurn(ctx, handle.agent, 'call both MCP tools')
    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')

    // Both calls are native model steps, so both own a tool/result row.
    expect(calls.map(event => event.data.name)).toEqual([
      `mcp__${SERVER_NAME}__add`,
      `mcp__${SERVER_NAME}__fail`,
    ])
    expect(results).toHaveLength(2)
    const byCall = new Map(results.map(event => [event.data.message.content[0].toolCallId, event.data.message.content[0]]))
    expect(byCall.get(ToolCallId('native-add') as never)).toMatchObject({ isError: false })
    // The failure the journal taps: a `tool/result` whose subject IS the ability.
    expect(byCall.get(ToolCallId('native-fail') as never)).toMatchObject({ isError: true })
    await handle.dispose()
  }, 60_000)
})

describe('MCP server under PTC mode', () => {
  it('declares the MCP tools in the SDK, keeps the wire at [run_code], and dispatches them', async () => {
    ctx = await harness('ptc', [
      {
        kind: 'call',
        id: 'ptc-program',
        name: RUN_CODE_NAME,
        arguments: JSON.stringify({ code: PROGRAM, description: 'exercise the MCP bridge' }),
      },
      { kind: 'stop', text: 'done' },
    ])
    const handle = await ctx.agents.create({
      sessionId: SessionId('mcp-ptc'),
      agentOptions: { provider: 'scripted', model: 'scripted' },
    })

    // The assembly promises exactly what the program can bind.
    const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    const intro = assembly.sections.find(section => section.name === `mcp:${SERVER_NAME}`)?.text ?? ''
    expect(sdk).toContain(`mcp__${SERVER_NAME}__add`)
    expect(sdk).toContain(`mcp__${SERVER_NAME}__fail`)
    // The server section announces the server and its size, NOT its tool names:
    // every name is already declared right here in the SDK (and in the request's
    // `tools` array under native), so a second copy would only grow with the
    // server. What no single declaration carries is that a server is connected
    // and how much catalog it contributes — the fixture exposes six tools.
    expect(intro).toContain('providing 6 tools.')
    expect(intro).not.toContain(`mcp__${SERVER_NAME}__add`)
    // The SDK is the ONLY place a PTC program learns an MCP tool's parameters —
    // the wire carries no schema for them — so an `unknown` argument type is a
    // tool the program can only guess at. The MCP SDK's `inputSchema` carries
    // `$schema`, and a strict keyword check used to degrade the whole argument
    // map to `unknown`; this pins the typed rendering end to end.
    expect(sdk).toContain(`mcp__${SERVER_NAME}__add: {`)
    expect(sdk).toContain('a: number;')
    expect(sdk).toContain('b: number;')
    expect(sdk).not.toContain(`mcp__${SERVER_NAME}__add: unknown;`)

    const events = await driveTurn(ctx, handle.agent, 'use the MCP server from one program')

    // The wire never grows past the transport, MCP or not.
    const outerCalls = events.filter(event => event.type === 'tool/call')
    expect(outerCalls.map(event => event.data.name)).toEqual([RUN_CODE_NAME])

    // Both sub-calls landed through the bridge, under the outer call.
    const dispatches = events.filter(event => event.type === 'tool/ptc-dispatch')
    expect(dispatches.map(event => event.data.name)).toEqual([
      `mcp__${SERVER_NAME}__add`,
      `mcp__${SERVER_NAME}__fail`,
    ])
    expect(dispatches.every(event => event.data.parentCallId === outerCalls[0]?.data.callId)).toBe(true)
    const [added, failed] = dispatches
    expect(added).toMatchObject({ data: { isError: false } })
    // The failure is real, and it is addressed to the tool that broke.
    expect(failed).toMatchObject({ data: { isError: true } })

    // The program saw the success as a canonical `McpResult` value and the
    // failure as a typed throw — the failure is CONTAINED, so the transport call
    // itself succeeds.
    const outerResults = events.filter(event => event.type === 'tool/result')
    expect(outerResults).toHaveLength(1)
    const outer = outerResults[0]?.data.message.content[0]
    expect(outer).toMatchObject({ isError: false })
    const payload = JSON.parse((outer?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')) as Record<string, unknown>
    expect(payload).toEqual({
      // The PTC binding resolves to the tool's typed canonical JSON value, which
      // for an MCP tool is the protocol result itself — not the text the model
      // would have read in native mode.
      sum: { content: [{ type: 'text', text: '5' }] },
      failure: {
        name: 'ToolCallError',
        toolName: `mcp__${SERVER_NAME}__fail`,
        message: MCP_FAILURE_TEXT,
      },
    })

    await handle.dispose()
  }, 120_000)

  it('leaves no tool/result for a sub-call failure, which is what the error journal taps', async () => {
    // The program does NOT catch: the failure escapes into the transport call.
    const program = `await tools.mcp__${SERVER_NAME}__fail({}); return 'unreachable';`
    ctx = await harness('ptc', [
      {
        kind: 'call',
        id: 'ptc-throw',
        name: RUN_CODE_NAME,
        arguments: JSON.stringify({ code: program, description: 'let the MCP failure escape' }),
      },
      { kind: 'stop', text: 'done' },
    ])
    const handle = await ctx.agents.create({
      sessionId: SessionId('mcp-ptc-escalated'),
      agentOptions: { provider: 'scripted', model: 'scripted' },
    })

    const events = await driveTurn(ctx, handle.agent, 'let the MCP failure escape the program')
    const results = events.filter(event => event.type === 'tool/result')

    // One result row for the whole run, and its subject is the TRANSPORT: there is
    // no `tool/result` naming the MCP tool, so the journal (which pairs a
    // `tool/call` name with a `tool/result`) can only ever file this under
    // `run_code` — a name no prompt section serves, so the lesson lands in the
    // document's global pile instead of the failing server's section.
    expect(results).toHaveLength(1)
    expect(results[0]?.data.message.content[0]).toMatchObject({ isError: true })
    const outerCallIds = new Set(events.filter(event => event.type === 'tool/call').map(event => event.data.callId))
    const subCallResults = results.filter(event => !outerCallIds.has(event.data.message.content[0].toolCallId))
    expect(subCallResults).toEqual([])
    // The failure is still durable — just under a name the reflection chain cannot route.
    expect(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.isError)).toBe(true)

    await handle.dispose()
  }, 120_000)
})
