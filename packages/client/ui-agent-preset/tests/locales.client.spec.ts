/** Web-localized copy for the shipped presets and file copy for every other row. */

import { describe, expect, it } from 'vitest'
import { en, presetDisplayText, zh } from '../src/client/locales.ts'

const translate = (bundle: typeof en) => (key: keyof typeof en): string => bundle[key]

describe('preset display copy', () => {
  it.each([
    ['standard', 'presetStandardName', 'presetStandardDescription'],
    ['lean', 'presetLeanName', 'presetLeanDescription'],
    ['ptc', 'presetPtcName', 'presetPtcDescription'],
    ['ptc-opt', 'presetPtcOptName', 'presetPtcOptDescription'],
    ['minimal', 'presetMinimalName', 'presetMinimalDescription'],
    ['cordis', 'presetCordisName', 'presetCordisDescription'],
  ] as const)('localizes the shipped %s preset in English and Chinese', (id, nameKey, descriptionKey) => {
    const preset = { id, trust: 'system' as const, name: 'file name', description: 'file description' }

    expect(presetDisplayText(preset, translate(en)))
      .toEqual({ name: en[nameKey], description: en[descriptionKey] })
    expect(presetDisplayText(preset, translate(zh)))
      .toEqual({ name: zh[nameKey], description: zh[descriptionKey] })
  })

  it('localizes every shipped preset directory the roster discovers', async () => {
    // The dictionary and `BUILT_IN_PRESET_KEYS` are two lists that must agree,
    // and the shipped root is a third: a preset directory missing from either
    // list falls through to its own file metadata, which is Chinese in every
    // locale — an English UI showing a Chinese picker row. Reading the roster
    // off disk is what keeps a newly added preset from shipping that way.
    //
    // The root is addressed by relative path rather than through
    // `dsh-agent-presets/discovery`: the package exports that module only from
    // its built artifact, and this lane resolves workspace names to source.
    const { readdir } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const ids = (await readdir(fileURLToPath(new URL('../../../preset/agent-presets/presets/', import.meta.url)), {
      withFileTypes: true,
    }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()

    expect(ids).toEqual(['cordis', 'lean', 'minimal', 'ptc', 'ptc-opt', 'standard'])
    for (const id of ids) {
      const preset = { id, trust: 'system' as const }
      const localizedEn = presetDisplayText(preset, translate(en))
      const localizedZh = presetDisplayText(preset, translate(zh))
      expect(localizedEn.name, id).not.toBe(id)
      expect(localizedEn.description, id).toBeDefined()
      expect(localizedZh.name, id).not.toBe(localizedEn.name)
    }
  })

  it('keeps file metadata for user and unknown system presets', () => {
    const fileCopy = { name: '我的标准', description: '团队自己的 preset。' }

    expect(presetDisplayText({ id: 'standard', trust: 'user', ...fileCopy }, translate(en)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'deployment-extra', trust: 'system', ...fileCopy }, translate(en)))
      .toEqual(fileCopy)
    expect(presetDisplayText({ id: 'bare', trust: 'user' }, translate(en)))
      .toEqual({ name: 'bare' })
  })
})
