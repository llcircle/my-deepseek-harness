/** What the browser half registers, and that it all leaves with the fiber. */

import { Context, symbols } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  ConfigurablePluginsTabFace, PluginsSettingsSectionInjected,
} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SubagentModelSelectionCardController } from '../src/client/subagent-model-selection-card-controller.ts'
import type { PromptOverridesCardFace } from '../src/client/prompt-overrides-card-controller.ts'
import { apply as hostApply } from '../src/index.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

/**
 * @param served - namespaces the Host describes; omitted answers a failed read,
 * which is what most of these specs want (no card has anything to render).
 * @param session - session id the card surface sees as open; omitted means no
 * session, which is what the correction button reads before it can run.
 */
async function bench(served?: string[], session?: string) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeCredentials = vi.fn(() => Promise.resolve({
    ok: false, error: new RemoteError('gateway/internal', 'no provider', {}),
  }))
  const models = vi.fn(() => Promise.resolve({
    ok: true as const, value: { groups: [], failures: [] },
  }))
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : {
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: served.map(ns => ({
          ns, schema: {}, value: {}, applies: 'live', secrets: [], revision: 0,
        })),
      },
    }))
  const executeCommand = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { result: { kind: 'success' as const, text: 'Correction child started.' } },
  }))
  // The Remote double lives in its own fiber, the way the shipped Client Remote
  // service does, and carries the same service tracker. Both matter: a service
  // provided at the root is reachable from every fiber by ancestor walk, and a
  // plain object answers `ctx.remote.<namespace>` without Cordis's associate
  // redirect. Together they would hide a missing `remote.<namespace>` inject
  // entry — the failure this bench has to be able to produce.
  let remote!: TestRemote
  await ctx.plugin((host: Context) => {
    remote = new TestRemote(host, {
      credentials: { describe: describeCredentials, set: vi.fn() },
      session: { modelCatalog: models },
      settings: { describe: describeSettings },
      skills: { list: vi.fn(() => Promise.resolve({ ok: true, value: { skills: [] } })) },
      commands: { execute: executeCommand },
    })
    Object.defineProperty(remote, symbols.tracker, {
      value: { associate: 'remote', property: 'ctx' },
    })
  }).await()
  const sessions = {
    list: {
      getSnapshot: () => session === undefined
        ? { current: undefined, byId: {} }
        : { current: session, byId: { [session]: { cwd: 'C:/workspace' } } },
      subscribe: () => () => {},
    },
  }
  ctx.provide('sessions', sessions)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, describeCredentials, describeSettings, models, remote,
    executeCommand,
  }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.commands', 'remote.credentials', 'remote.session',
      'remote.skills', 'remote.settings', 'sessions', 'settingsScope',
    ])
  })

  it('registers one Plugins section and declares the tab and card slots', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('插件')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
    const tab = slots.entries('settings.plugins.tab')[0]!
    expect(tab.options).toMatchObject({ id: 'configurable', order: 0 })
    expect(resolveSlotLabel(tab.options.label)).toBe('插件配置')
    expect(slots.spec('settings.plugin.item')).toMatchObject({ kind: 'keyed', scope: 'root' })
  })


  it('injects a live tab projection, the card directory, and one business face per card', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const sectionFace = (section.inject as unknown as () => PluginsSettingsSectionInjected)()
    const initialTabs = sectionFace.hooks.tabs.getSnapshot()
    expect(initialTabs).toEqual([
      { id: 'configurable', order: 0, label: '插件配置' },
    ])
    expect(sectionFace.hooks.tabs.getSnapshot()).toBe(initialTabs)

    const listener = vi.fn()
    const unsubscribe = sectionFace.hooks.tabs.subscribe(listener)
    slots.register({ name: 'settings.plugins.tab', id: 'plain' } as never, () => null)
    expect(sectionFace.hooks.tabs.getSnapshot()).toEqual([
      { id: 'configurable', order: 0, label: '插件配置' },
      { id: 'plain', order: 0, label: '' },
    ])
    unsubscribe()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const tabFace = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    expect(Object.keys(tabFace.hooks)).toEqual(['configurablePlugins'])
    for (const entry of slots.entries('settings.plugin.item')) {
      const face = (entry as { inject?: () => unknown }).inject?.() as { hooks: Record<string, unknown> }
      // Each card injects exactly one snapshot store plus its own actions.
      expect(Object.keys(face.hooks)).toHaveLength(1)
    }
  })

  it('keys each card it ships on the settings namespace that card edits', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('settings.plugin.item').map(entry => entry.options.key))
      .toEqual(['shell', 'agent-loop', 'subagent-model-selection', 'web-search-deepseek', 'skill-filesystem', 'llm-deepseek', 'system-prompt-overrides'])
  })

  it('dispatches the served namespaces its cards claim, and no others', async () => {
    // ui-theme is served but belongs to another surface, and a deployment
    // composing no PowerShell/POSIX executor serves no `bash` at all.
    const { ctx, slots } = await bench(['agent-loop', 'ui-theme', 'web-search-deepseek'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const tab = slots.entries('settings.plugins.tab')[0]!
    const face = (tab.inject as unknown as () => ConfigurablePluginsTabFace)()
    await vi.waitFor(() => {
      expect(face.hooks.configurablePlugins.getSnapshot().namespaces)
        .toEqual(['agent-loop', 'web-search-deepseek'])
    })
  })

  it('re-reads the served namespaces when the Host commits a settings document', async () => {
    // Which namespaces the Host serves is a registration fact the wire never
    // announces on its own, so the tab rides the invalidation that can
    // accompany a changed composition.
    const { ctx, slots, describeSettings, remote } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    remote.emit('settings/document-updated', ['bash', 1])

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the served namespaces after a reconnect', async () => {
    const { ctx, slots, describeSettings } = await bench(['bash'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
    describeSettings.mockClear()

    ctx.emit('connection/reset')

    await vi.waitFor(() => { expect(describeSettings).toHaveBeenCalled() })
  })

  it('re-reads the credential when the Host reports the watched reference changed', async () => {
    const { ctx, slots, describeCredentials, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    // A key written on another surface changes no settings section, so this
    // event is the only thing that reaches the card.
    remote.emit('credentials/reference-updated', ['DEEPSEEK_API_KEY'])

    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalledTimes(1) })
  })

  it('refreshes the subagent catalog after model inputs change or the connection resets', async () => {
    const refresh = vi.spyOn(SubagentModelSelectionCardController.prototype, 'refreshCatalog')
    const reset = vi.spyOn(SubagentModelSelectionCardController.prototype, 'resetConnection')
    const { ctx, slots, remote } = await bench(['subagent-model-selection'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    refresh.mockClear()
    reset.mockClear()

    remote.emit('llm/adapters-updated', [])
    expect(refresh).toHaveBeenCalledTimes(1)
    remote.emit('settings/document-updated', ['llm-deepseek', 1])
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.emit('connection/reset')
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('ignores a credential change for a reference no card watches', async () => {
    const { ctx, slots, describeCredentials, remote } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(describeCredentials).toHaveBeenCalled() })
    describeCredentials.mockClear()

    remote.emit('credentials/reference-updated', ['SOME_OTHER_KEY'])
    await Promise.resolve()

    expect(describeCredentials).not.toHaveBeenCalled()
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('runs the correction command through the commands remote in the open session', async () => {
    // Guards a hole only the running plugin shows: a Remote namespace is its own
    // Cordis service, so a missing `remote.<name>` inject entry still loads the
    // plugin and only throws when the call site finally reads it.
    const { ctx, slots, executeCommand } = await bench(undefined, 'session-open')
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const card = slots.entries('settings.plugin.item')
      .find(entry => entry.options.key === 'system-prompt-overrides')!
    const face = (card as { inject?: () => unknown }).inject?.() as PromptOverridesCardFace

    face.runCorrection()

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledWith('session-open', '/correct-errors', [])
    })
    await vi.waitFor(() => {
      expect(face.hooks.promptOverridesCard.getSnapshot().correction)
        .toEqual({ phase: 'done', message: 'Correction child started.' })
    })
  })

  it('reports the correction as unavailable when no session is open', async () => {
    const { ctx, slots, executeCommand } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const card = slots.entries('settings.plugin.item')
      .find(entry => entry.options.key === 'system-prompt-overrides')!
    const face = (card as { inject?: () => unknown }).inject?.() as PromptOverridesCardFace
    face.runCorrection()

    expect(face.hooks.promptOverridesCard.getSnapshot().correction).toEqual({ phase: 'unavailable' })
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.plugin.item')).toHaveLength(7)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.spec('settings.plugins.tab')).toBeUndefined()
    expect(slots.spec('settings.plugin.item')).toBeUndefined()
  })
})
