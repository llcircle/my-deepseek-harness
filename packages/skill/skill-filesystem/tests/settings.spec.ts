/**
 * The `skill-filesystem` settings namespace: a committed trigger-state
 * override reaches discovery and load without re-registering the provider.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { afterEach, describe, expect, it } from 'vitest'
import * as SkillFileSystem from '../src/index.ts'

const NS = SkillFileSystem.SKILL_FILESYSTEM_SETTINGS_NAMESPACE

/**
 * The resolved value of this plugin's settings namespace. `ctx.settings.get()`
 * answers `unknown` by design — the reader owns the type — so the assertion
 * names the namespace's own published shape instead of casting at each site.
 */
function resolvedTriggerSettings(ctx: Context): SkillFileSystem.SkillTriggerSettings {
  return ctx.settings.get(NS) as SkillFileSystem.SkillTriggerSettings
}

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-settings-'))
  tempDirs.push(home)
  const settingsFile = join(home, 'settings.yaml')
  await writeFile(settingsFile, '{}\n')
  const skills = join(home, '.dsh/skills')
  await mkdir(join(skills, 'skill-a'), { recursive: true })
  await writeFile(join(skills, 'skill-a', 'SKILL.md'), '---\nname: skill-a\ndescription: A\n---\n\nBody.\n')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FileSettingsProvider, { path: settingsFile, watch: false })
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    watch: false,
  })
  return ctx
}

describe('the skill-filesystem trigger settings namespace', () => {
  it('applies committed trigger-state overrides to discovery and load', async () => {
    const ctx = await setup()

    expect((await ctx.skills.get('skill-a'))?.invocation).toEqual({
      modelInvocable: true,
      userInvocable: true,
    })

    await ctx.settings.update(NS, { invocationOverrides: { 'skill-a': 'active-only' } })

    expect(resolvedTriggerSettings(ctx).invocationOverrides).toEqual({ 'skill-a': 'active-only' })
    expect((await ctx.skills.get('skill-a'))?.invocation).toEqual({
      modelInvocable: false,
      userInvocable: true,
    })
    const listed = await ctx.skills.list()
    expect(listed.find(skill => skill.name === 'skill-a')?.invocation).toEqual({
      modelInvocable: false,
      userInvocable: true,
    })

    await ctx.settings.replace(NS, { invocationOverrides: {} })

    expect((await ctx.skills.get('skill-a'))?.invocation).toEqual({
      modelInvocable: true,
      userInvocable: true,
    })
  })

  it('lets a workspace section override the global trigger state', async () => {
    const ctx = await setup()
    const home = tempDirs.at(-1)!
    await ctx.settings.update(NS, {
      invocationOverrides: { 'skill-a': 'passive' },
      projects: {
        [home]: { invocationOverrides: { 'skill-a': 'ignored' } },
      },
    })

    expect((await ctx.skills.get('skill-a', { cwd: home }))?.invocation).toEqual({
      modelInvocable: false,
      userInvocable: false,
    })
    expect((await ctx.skills.get('skill-a'))?.invocation).toEqual({
      modelInvocable: true,
      userInvocable: true,
    })
  })

  it('rejects a trigger override whose key is not a valid skill name', async () => {
    const ctx = await setup()

    await expect(ctx.settings.update(NS, {
      invocationOverrides: { Bad_Name: 'ignored' },
    })).rejects.toThrow('not a valid skill name')
  })
})
