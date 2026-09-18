/**
 * The llm-deepseek retry card controller: staged mode/count edits, nested
 * whole-object vs single-field writes, failed-save retention, and loud
 * invalid-input blocking.
 */

import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  LlmRetryCardController, type LlmRetrySettings,
} from '../src/client/llm-retry-card-controller.ts'

/** A ready scope serving one committed retry policy. */
function readyScope(policy?: LlmRetrySettings['retryPolicy']) {
  const host = stubSettingsScope<LlmRetrySettings>()
  host.publish({
    status: 'ready',
    writable: true,
    revision: 1,
    // exactOptionalPropertyTypes: an absent policy is an absent key, not `undefined`.
    value: policy === undefined ? {} : { retryPolicy: policy },
    base: {},
    user: policy === undefined ? {} : { retryPolicy: policy },
  })
  return host
}

/** Make the stub behave like a Host that accepts every mutate. */
function acceptMutates(host: ReturnType<typeof stubSettingsScope<LlmRetrySettings>>): void {
  host.mutate.mockImplementation((ops: readonly { op: string; path: string[]; value?: unknown }[]) => {
    const user = { ...(host.scope.getSnapshot().user as Record<string, unknown>) }
    const section = { ...(host.scope.getSnapshot().value as Record<string, unknown>) }
    for (const op of ops) {
      if (op.path.length === 1) {
        section[op.path[0] as string] = op.value
        user[op.path[0] as string] = op.value
      } else {
        const nested = { ...(section[op.path[0] as string] as Record<string, unknown>) }
        nested[op.path[1] as string] = op.value
        section[op.path[0] as string] = nested
        user[op.path[0] as string] = nested
      }
    }
    host.publish({ value: section, user: user })
  })
}
/** The controller's current rendered state. */
function stateOf(controller: LlmRetryCardController) {
  return controller.inject().hooks.llmRetryCard.getSnapshot()
}

/** The injected face whose actions the card binds. */
function faceOf(controller: LlmRetryCardController) {
  return controller.inject()
}

describe('LlmRetryCardController', () => {
  it('renders the committed mode and default count when no policy is stored', () => {
    const host = readyScope(undefined)
    const controller = new LlmRetryCardController(host.scope)

    const state = stateOf(controller)
    expect(state.mode).toBe('normal')
    expect(state.maxRetries).toBe(5)
    expect(state.dirty).toBe(false)
    expect(state.available).toBe(true)
  })

  it('stages a count and writes the whole policy when none is stored', async () => {
    const host = readyScope(undefined)
    acceptMutates(host)
    const controller = new LlmRetryCardController(host.scope)

    faceOf(controller).editMaxRetries('9')
    expect(stateOf(controller).dirty).toBe(true)

    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['retryPolicy'],
      value: { mode: 'normal', maxRetries: 9 },
    }])
  })

  it('mutates only maxRetries when a normal policy is already stored', async () => {
    const host = readyScope({ mode: 'normal', maxRetries: 5 })
    acceptMutates(host)
    const controller = new LlmRetryCardController(host.scope)

    faceOf(controller).editMaxRetries('3')
    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['retryPolicy', 'maxRetries'],
      value: 3,
    }])
    const state = stateOf(controller)
    expect(state.dirty).toBe(false)
    expect(state.maxRetries).toBe(3)
  })

  it('stages always mode and writes the mode-only policy', async () => {
    const host = readyScope({ mode: 'normal', maxRetries: 5 })
    acceptMutates(host)
    const controller = new LlmRetryCardController(host.scope)

    faceOf(controller).editMode('always')
    const state = stateOf(controller)
    expect(state.mode).toBe('always')
    expect(state.maxRetries).toBeUndefined()

    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['retryPolicy'],
      value: { mode: 'always' },
    }])
  })

  it('blocks saving a negative count and marks it invalid', () => {
    const host = readyScope(undefined)
    const controller = new LlmRetryCardController(host.scope)

    faceOf(controller).editMaxRetries('-1')
    const state = stateOf(controller)
    expect(state.invalid).toBe(true)
    expect(state.maxRetriesInvalid).toBe(true)

    faceOf(controller).save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('marks a rejected write failed and keeps the staged edits', async () => {
    const host = readyScope(undefined)
    const controller = new LlmRetryCardController(host.scope)

    faceOf(controller).editMaxRetries('9')
    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    const state = stateOf(controller)
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true)
  })

  it('drops staged edits on discard', () => {
    const host = readyScope({ mode: 'normal', maxRetries: 5 })
    const controller = new LlmRetryCardController(host.scope)

    faceOf(controller).editMaxRetries('9')
    faceOf(controller).discard()

    const state = stateOf(controller)
    expect(state.dirty).toBe(false)
    expect(state.maxRetries).toBe(5)
  })
})
