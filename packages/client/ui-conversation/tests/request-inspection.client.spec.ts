import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ConversationPromptSection, SystemPromptNode } from '../src/client/contract/request-inspection.ts'
import { inspectRequestPrompt, promptSectionChanges } from '../src/client/contract/request-inspection.ts'

const CONFIG = { provider: 'test', model: 'test' }
const READ_TOOL = { name: 'read', description: 'Read a file', parameters: { type: 'object' } }
const WRITE_TOOL = { name: 'write', description: 'Write', parameters: { type: 'object' } }

function sections(...entries: readonly (readonly [string, string])[]): ConversationPromptSection[] {
  return entries.map(([name, text]) => ({ name, text }))
}

function header(
  seq: SessionSeq,
  reason: SessionEvent<'request/header'>['data']['reason'],
  value: SessionEvent<'request/header'>['data']['header'],
): SessionEvent<'request/header'> {
  return {
    type: 'request/header',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { reason, header: value },
  }
}

function systemNode(seq: number, text: string, update = false): SystemPromptNode {
  return { seq, time: 1_700_000_000_000 + seq, turn: 1, step: seq, text, update }
}

describe('inspectRequestPrompt', () => {
  it('classifies the first complete header as the initial prompt anchored at its system node', () => {
    expect(inspectRequestPrompt(undefined, header(SessionSeq(3), 'initial', {
      config: CONFIG,
      tools: [READ_TOOL],
    }), systemNode(1, '# System\n\nFollow instructions.'))).toMatchObject({
      prompt: {
        config: CONFIG,
        system: '# System\n\nFollow instructions.',
        tools: [{ name: 'read' }],
      },
      change: { seq: 1, time: 1_700_000_000_001, kind: 'initial' },
    })
  })

  it('anchors an initial header without a system node at the header itself', () => {
    expect(inspectRequestPrompt(undefined, header(SessionSeq(2), 'initial', {
      config: CONFIG,
    }), undefined)).toEqual({
      prompt: { config: CONFIG, system: '', tools: [] },
      change: { seq: 2, time: 1_700_000_000_002, kind: 'initial' },
    })
  })

  it('suppresses a resume header when the earlier prompt is outside the loaded window', () => {
    expect(inspectRequestPrompt(undefined, header(SessionSeq(2), 'resume', {
      config: CONFIG,
    }), systemNode(1, 'same prompt'))).toEqual({
      prompt: { config: CONFIG, system: 'same prompt', tools: [] },
    })
  })

  it('classifies system, tool, and combined changes against the previous prompt', () => {
    const initial = inspectRequestPrompt(undefined, header(SessionSeq(2), 'initial', {
      config: CONFIG,
      tools: [READ_TOOL],
    }), systemNode(1, 'first')).prompt
    const system = inspectRequestPrompt(initial, header(SessionSeq(4), 'series', {
      config: CONFIG,
      tools: [...initial.tools],
    }), systemNode(3, 'second'))
    const tools = inspectRequestPrompt(system.prompt, header(SessionSeq(5), 'change', {
      config: CONFIG,
      tools: [WRITE_TOOL],
    }), systemNode(3, 'second'))
    const combined = inspectRequestPrompt(tools.prompt, header(SessionSeq(7), 'change', {
      config: CONFIG,
      tools: [],
    }), systemNode(6, 'third'))

    expect(system.change).toEqual({ seq: 3, time: 1_700_000_000_003, kind: 'system', previous: initial })
    expect(tools.change).toEqual({ seq: 5, time: 1_700_000_000_005, kind: 'tools', previous: system.prompt })
    expect(combined.change).toEqual({
      seq: 6, time: 1_700_000_000_006, kind: 'system-and-tools', previous: tools.prompt,
    })
  })

  it('reports an emptied system prompt as a system change anchored at the replacing node', () => {
    const initial = inspectRequestPrompt(undefined, header(SessionSeq(2), 'initial', {
      config: CONFIG,
    }), systemNode(1, 'first')).prompt

    expect(inspectRequestPrompt(initial, header(SessionSeq(4), 'series', {
      config: CONFIG,
    }), systemNode(3, ''))).toEqual({
      prompt: { config: CONFIG, system: '', tools: [] },
      change: { seq: 3, time: 1_700_000_000_003, kind: 'system', previous: initial },
    })
  })

  it('reports no system change for an in-history update the model already read at its own position', () => {
    const initial = inspectRequestPrompt(undefined, header(SessionSeq(2), 'initial', {
      config: CONFIG,
      tools: [READ_TOOL],
    }), systemNode(1, 'first')).prompt

    // A later series header carries the updated text without a system change…
    const series = inspectRequestPrompt(initial, header(SessionSeq(4), 'series', {
      config: CONFIG,
      tools: [READ_TOOL],
    }), systemNode(3, 'updated', true))
    expect(series).toEqual({ prompt: { config: CONFIG, system: 'updated', tools: [READ_TOOL] } })

    // …and a tools change alongside the update reports only the tools, anchored at the header.
    expect(inspectRequestPrompt(initial, header(SessionSeq(5), 'change', {
      config: CONFIG,
      tools: [WRITE_TOOL],
    }), systemNode(3, 'updated', true)).change).toEqual({
      seq: 5, time: 1_700_000_000_005, kind: 'tools', previous: initial,
    })
  })

  it('omits a change when the system node and tools are unchanged', () => {
    const previous = inspectRequestPrompt(undefined, header(SessionSeq(2), 'initial', {
      config: CONFIG,
    }), systemNode(1, 'same')).prompt

    expect(inspectRequestPrompt(previous, header(SessionSeq(3), 'resume', {
      config: { ...CONFIG, maxTokens: 1_024 },
    }), systemNode(1, 'same'))).toEqual({
      prompt: { config: { ...CONFIG, maxTokens: 1_024 }, system: 'same', tools: [] },
    })
  })

  it('attaches the sections a mid-session system change moved', () => {
    const previous = inspectRequestPrompt(undefined, header(SessionSeq(1), 'initial', {
      config: CONFIG,
      systemSections: sections(['tool:read', 'v1']),
    }), systemNode(1, 'a')).prompt

    const inspected = inspectRequestPrompt(previous, header(SessionSeq(3), 'change', {
      config: CONFIG,
      systemSections: sections(['tool:read', 'v2'], ['computer:policy', 'policy']),
    }), systemNode(2, 'b'))

    expect(inspected.change?.changedSections).toEqual([
      { name: 'tool:read', text: 'v2', change: 'updated' },
      { name: 'computer:policy', text: 'policy', change: 'added' },
    ])
  })

  it('leaves a tool-only change without moved sections', () => {
    const previous = inspectRequestPrompt(undefined, header(SessionSeq(1), 'initial', {
      config: CONFIG,
      systemSections: sections(['tool:read', 'v1']),
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    }), systemNode(1, 'a')).prompt

    const inspected = inspectRequestPrompt(previous, header(SessionSeq(2), 'change', {
      config: CONFIG,
      systemSections: sections(['tool:read', 'v1']),
      tools: [],
    }), systemNode(1, 'a'))

    expect(inspected.change?.kind).toBe('tools')
    expect(inspected.change?.changedSections).toBeUndefined()
  })
})

describe('promptSectionChanges', () => {
  it('names added, updated, and removed sections with the current prompt first', () => {
    expect(promptSectionChanges(
      sections(['tool:read', 'v1'], ['tool:write', 'w'], ['mcp:gone', 'o']),
      sections(['tool:read', 'v2'], ['tool:write', 'w'], ['computer:policy', 'p']),
    )).toEqual([
      { name: 'tool:read', text: 'v2', change: 'updated' },
      { name: 'computer:policy', text: 'p', change: 'added' },
      { name: 'mcp:gone', text: '', change: 'removed' },
    ])
  })

  it('reports no difference for identical snapshots', () => {
    const same = sections(['tool:read', 'v1'])
    expect(promptSectionChanges(same, same)).toEqual([])
  })

  it('refuses to diff when a snapshot carries no source sections', () => {
    // An older header recorded the rendered text alone; "no difference" would be
    // a claim about an unknown, so the caller must fall back to the whole prompt.
    expect(promptSectionChanges(undefined, sections(['tool:read', 'v1']))).toBeUndefined()
    expect(promptSectionChanges(sections(['tool:read', 'v1']), undefined)).toBeUndefined()
  })
})
