/**
 * The skill-trigger card controller: staged rows, name validation, whole-dict
 * saves, and the failed-save outcome read back from the user layer.
 */

import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SkillTriggerCardController, type SkillTriggerSettings, type SkillTriggerStateValue,
} from '../src/client/skill-trigger-card-controller.ts'

/** Make the stub behave like a Host that accepts every set. */
function acceptSets(host: ReturnType<typeof stubSettingsScope<SkillTriggerSettings>>): void {
  host.set.mockImplementation((field: string, value: unknown) => {
    const section = { ...(host.scope.getSnapshot().value as Record<string, unknown>) }
    const user = { ...(host.scope.getSnapshot().user as Record<string, unknown>) }
    section[field] = value
    user[field] = value
    host.publish({ value: section, user: user })
  })
}

/** A ready scope serving one committed override map. */
function readyScope(
  overrides: Record<string, SkillTriggerStateValue> = {},
  projects: SkillTriggerSettings['projects'] = {},
) {
  const host = stubSettingsScope<SkillTriggerSettings>()
  host.publish({
    status: 'ready',
    writable: true,
    revision: 1,
    value: { invocationOverrides: overrides, projects },
    base: { invocationOverrides: {}, projects: {} },
    user: { invocationOverrides: overrides, projects },
  })
  return host
}

/** The controller's current rendered state. */
function stateOf(controller: SkillTriggerCardController) {
  return controller.inject().hooks.skillTriggerCard.getSnapshot()
}

/** The injected face whose actions the card binds. */
function faceOf(controller: SkillTriggerCardController) {
  return controller.inject()
}

describe('SkillTriggerCardController', () => {
  it('renders committed rows sorted and clean', () => {
    const host = readyScope({ 'b-skill': 'ignored', 'a-skill': 'passive' })
    const controller = new SkillTriggerCardController(host.scope)

    const state = stateOf(controller)
    expect(state.rows.map(row => row.name)).toEqual(['a-skill', 'b-skill'])
    expect(state.dirty).toBe(false)
    expect(state.invalid).toBe(false)
    expect(state.available).toBe(true)
  })

  it('stages row edits and saves the whole dict', async () => {
    const host = readyScope()
    const controller = new SkillTriggerCardController(host.scope)

    faceOf(controller).addRow()
    faceOf(controller).editRowName(0, 'my-skill')
    faceOf(controller).editRowState(0, 'ignored')
    expect(stateOf(controller).dirty).toBe(true)

    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.set).toHaveBeenCalledWith('invocationOverrides', { 'my-skill': 'ignored' })
  })

  it('clears the staged rows after the Host accepts the write', async () => {
    const host = readyScope()
    acceptSets(host)
    const controller = new SkillTriggerCardController(host.scope)
    faceOf(controller).addRow()
    faceOf(controller).editRowName(0, 'my-skill')

    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    const state = stateOf(controller)
    expect(state.dirty).toBe(false)
    expect(state.rows.map(row => row.name)).toEqual(['my-skill'])
  })

  it('blocks saving while a name is invalid or duplicated', () => {
    const host = readyScope()
    const controller = new SkillTriggerCardController(host.scope)

    faceOf(controller).addRow()
    faceOf(controller).editRowName(0, 'Bad_Name')
    expect(stateOf(controller).invalid).toBe(true)
    faceOf(controller).save()
    expect(host.set).not.toHaveBeenCalled()

    faceOf(controller).editRowName(0, 'my-skill')
    faceOf(controller).addRow()
    faceOf(controller).editRowName(1, 'my-skill')
    expect(stateOf(controller).invalid).toBe(true)
    faceOf(controller).save()
    expect(host.set).not.toHaveBeenCalled()
  })

  it('marks a rejected write failed and keeps the staged rows', async () => {
    const host = readyScope()
    const controller = new SkillTriggerCardController(host.scope)
    faceOf(controller).addRow()
    faceOf(controller).editRowName(0, 'my-skill')

    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    const state = stateOf(controller)
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true)
  })

  it('drops staged rows on discard', () => {
    const host = readyScope({ 'kept-skill': 'ignored' })
    const controller = new SkillTriggerCardController(host.scope)
    faceOf(controller).addRow()

    faceOf(controller).discard()

    const state = stateOf(controller)
    expect(state.dirty).toBe(false)
    expect(state.rows.map(row => row.name)).toEqual(['kept-skill'])
  })

  it('seeds rows from the live skill catalog', async () => {
    const host = readyScope()
    const controller = new SkillTriggerCardController(host.scope, {
      loadSkills: async () => [
        { name: 'z-skill', modelInvocable: true },
        { name: 'a-skill', modelInvocable: false },
      ],
      workspace: () => '/project',
      sessionId: () => 'session-1' as never,
    })
    await Promise.resolve()
    await Promise.resolve()

    const state = stateOf(controller)
    expect(state.rows.map(row => row.name)).toEqual(['a-skill', 'z-skill'])
    expect(state.rows.map(row => row.state)).toEqual(['active-only', 'passive'])
    expect(state.scope).toBe('project')
    expect(state.workspace).toBe('/project')
  })

  it('saves project rows under the current workspace', async () => {
    const host = readyScope({}, {})
    const controller = new SkillTriggerCardController(host.scope, {
      loadSkills: async () => [{ name: 'my-skill', modelInvocable: true }],
      workspace: () => '/project',
      sessionId: () => 'session-1' as never,
    })
    await Promise.resolve()
    await Promise.resolve()
    faceOf(controller).setScope('project')
    faceOf(controller).editRowState(0, 'ignored')

    faceOf(controller).save()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.set).toHaveBeenCalledWith('projects', {
      '/project': { invocationOverrides: { 'my-skill': 'ignored' } },
    })
  })
})
