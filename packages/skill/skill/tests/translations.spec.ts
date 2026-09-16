import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readSkillTranslations,
  SKILL_TRANSLATION_FILES,
  skillTranslationFiles,
} from '@deepseek-ai/dsh-skill/translations'

/** 本文件创建的临时目录，每个用例后清掉。 */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** 把一个归档写进给定的绝对路径，必要时建目录。 */
async function writeArchive(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

describe('skillTranslationFiles', () => {
  it('puts the workspace archive ahead of the shared harness-home one', async () => {
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    expect(skillTranslationFiles(workspace, '.dsh/skill-translations.zh.json', home)).toEqual([
      join(workspace, '.dsh/skill-translations.zh.json'),
      join(home, 'skill-translations.zh.json'),
    ])
  })

  it('expands every configured name into a workspace/shared pair', async () => {
    // The slash menu reads two historical file names; each one must still get
    // its shared fallback, or an un-translated new project stays English there.
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    expect(skillTranslationFiles(workspace, SKILL_TRANSLATION_FILES, home)).toEqual([
      join(workspace, '.dsh/skill-translations.zh.json'),
      join(home, 'skill-translations.zh.json'),
      join(workspace, '.dsh/skill-translations.json'),
      join(home, 'skill-translations.json'),
    ])
  })

  it('keeps an absolute configured path and still appends the shared archive', async () => {
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    const configured = join(home, 'pinned', 'skill-translations.zh.json')
    expect(skillTranslationFiles(workspace, configured, home)).toEqual([
      configured,
      join(home, 'skill-translations.zh.json'),
    ])
  })

  it('lists an archive once when the configured path already is the shared one', async () => {
    const workspace = await tempDir('translations-workspace')
    const home = await tempDir('translations-home')
    const shared = join(home, 'skill-translations.zh.json')
    expect(skillTranslationFiles(workspace, shared, home)).toEqual([shared])
  })
})

describe('readSkillTranslations', () => {
  it('covers a workspace that has no archive of its own from the shared one', async () => {
    // The defect this guards: skills live in a user-level registry, so an
    // archive written into one project used to read as empty everywhere else.
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await writeArchive(join(home, 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '测试驱动开发', whenToUse: '当你想用 TDD 开发' },
    }))

    const translations = await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toEqual({
      description: '测试驱动开发',
      whenToUse: '当你想用 TDD 开发',
    })
  })

  it('lets a workspace entry override the shared entry of the same name', async () => {
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await writeArchive(join(home, 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '共享译文' },
      diagnose: { description: '共享诊断' },
    }))
    await writeArchive(join(workspace, '.dsh', 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '本工作区译文' },
    }))

    const translations = await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toEqual({ description: '本工作区译文' })
    expect(translations.get('diagnose')).toEqual({ description: '共享诊断' })
  })

  it('merges per field so a partial entry never erases the other field', async () => {
    // description and whenToUse are written by different translation passes;
    // replacing the whole entry would make "fill in one field" delete the other.
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await writeArchive(join(home, 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '共享译文', whenToUse: '共享用法' },
    }))
    await writeArchive(join(workspace, '.dsh', 'skill-translations.zh.json'), JSON.stringify({
      tdd: { description: '本工作区译文' },
    }))

    const translations = await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toEqual({ description: '本工作区译文', whenToUse: '共享用法' })
  })

  it('reads the earlier bare-string shape', async () => {
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await writeArchive(join(home, 'skill-translations.zh.json'), JSON.stringify({ tdd: '测试驱动开发' }))

    const translations = await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toEqual({ description: '测试驱动开发' })
  })

  it('keeps an entry that carries only whenToUse', async () => {
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await writeArchive(join(home, 'skill-translations.zh.json'), JSON.stringify({
      tdd: { whenToUse: '当你想用 TDD 开发' },
    }))

    const translations = await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.get('tdd')).toEqual({ whenToUse: '当你想用 TDD 开发' })
  })

  it('drops blank values and entry shapes it does not understand', async () => {
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await writeArchive(join(home, 'skill-translations.zh.json'), JSON.stringify({
      blank: '   ',
      blankField: { description: '' },
      number: 7,
      list: ['nope'],
      nothing: null,
      empty: {},
    }))

    const translations = await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)

    expect(translations.size).toBe(0)
  })

  it('stays empty when no archive exists, the JSON is broken, or the root is not an object', async () => {
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    const configured = '.dsh/skill-translations.zh.json'
    expect((await readSkillTranslations(workspace, configured, home)).size).toBe(0)

    await writeArchive(join(workspace, configured), '{ not json')
    expect((await readSkillTranslations(workspace, configured, home)).size).toBe(0)

    await writeArchive(join(workspace, configured), '["not", "an", "object"]')
    expect((await readSkillTranslations(workspace, configured, home)).size).toBe(0)
  })

  it('reads an unreadable archive as no translations instead of failing', async () => {
    // A directory where a file is expected exercises the read error path; the
    // catalog must survive any archive problem.
    const home = await tempDir('translations-home')
    const workspace = await tempDir('translations-workspace')
    await mkdir(join(workspace, '.dsh', 'skill-translations.zh.json'), { recursive: true })

    expect((await readSkillTranslations(workspace, '.dsh/skill-translations.zh.json', home)).size).toBe(0)
  })
})
