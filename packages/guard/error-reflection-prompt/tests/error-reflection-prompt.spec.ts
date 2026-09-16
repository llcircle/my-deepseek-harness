/**
 * The error-reflection-prompt plugin: resolves its document path under the
 * Harness home, contributes no text for an absent or empty document, cuts a
 * capped tail on a heading boundary, and — the part that carries the feature —
 * routes each `## <主题>` section of the document to the prompt section of the
 * same name instead of dumping every lesson into one global pile.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as ReflectionPrompt from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reflection-prompt-'))
  tempDirs.push(dir)
  return dir
}

interface SectionStub {
  name: string
  order: number
  text: () => string
}

type ReflectionStub = (sectionName: string) => string | undefined

interface Harness {
  sections: SectionStub[]
  reflection: ReflectionStub
}

async function harness(options: ReflectionPrompt.Config): Promise<Harness> {
  const sections: SectionStub[] = []
  let reflection: ReflectionStub = () => undefined
  class FakeSystemPrompt extends Service {
    constructor(inner: Context) {
      super(inner, 'systemPrompt')
    }

    getSectionOrder(): number {
      return 9100
    }

    section(section: SectionStub): () => void {
      sections.push(section)
      return () => {}
    }

    reflectionSource(source: ReflectionStub): () => void {
      reflection = source
      return () => { reflection = () => undefined }
    }
  }
  const ctx = new Context()
  await ctx.plugin(FakeSystemPrompt, {})
  await ctx.plugin(ReflectionPrompt, options)
  return { sections, reflection: name => reflection(name) }
}

describe('the error-reflection-prompt plugin', () => {
  it('validates the caps at resolve time', () => {
    expect(() => ReflectionPrompt.resolveConfig({ maxPromptChars: 100 })).toThrow('maxPromptChars')
    expect(() => ReflectionPrompt.resolveConfig({ maxSubjectChars: 100 })).toThrow('maxSubjectChars')
  })

  it('contributes no text for an empty document', () => {
    expect(ReflectionPrompt.lessonsSectionText('   \n  ', 6000)).toBe('')
    expect(ReflectionPrompt.subjectLessonsText('   \n  ', 1200)).toBe('')
  })

  it('keeps a short document whole under the header line', () => {
    const text = ReflectionPrompt.lessonsSectionText('## 2026-09-08\nCheck the port before retrying.', 6000)
    expect(text).toContain('以下是从过去工具失败中总结的经验')
    expect(text).toContain('Check the port before retrying.')
  })

  it('cuts a long document on a heading boundary', () => {
    const long = `## old\n${'x'.repeat(7000)}\n## newest\nThe newest lesson body.`
    const text = ReflectionPrompt.lessonsSectionText(long, 6000)
    expect(text).toContain('## newest')
    expect(text).not.toContain('## old')
  })

  it('registers one lessons section that reads the document\'s global part', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    // 认不出主题的历史小节与前言都属于"全局"部分，仍然整段注入——升级文档格式
    // 不该让已经躺在磁盘上的经验凭空消失。
    await writeFile(docPath, '手写的通用备注。\n\n## 2026-09-08\nDo not retry a 4xx.', 'utf8')
    const { sections } = await harness({ docPath })

    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe(ReflectionPrompt.SECTION_NAME)
    expect(sections[0]?.text()).toContain('手写的通用备注。')
    expect(sections[0]?.text()).toContain('Do not retry a 4xx.')
  })

  it('routes each subject section to its own prompt section', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    await writeFile(docPath, [
      '## tool:read',
      '读大文件要先看行数。',
      '',
      '## mcp__github__search',
      '仓库名要带 owner。',
      '',
      '## computer:policy',
      '坐标先截图确认。',
    ].join('\n'), 'utf8')
    const { reflection } = await harness({ docPath })

    expect(reflection('tool:read')).toContain('读大文件要先看行数。')
    // MCP 公开工具名归一化成服务器级主题：一条经验不该按工具名碎片化。
    expect(reflection('mcp:github')).toContain('仓库名要带 owner。')
    expect(reflection('computer:policy')).toContain('坐标先截图确认。')
    // 没有对应分段的主题不产出文本——它会在装配时被直接丢掉。
    expect(reflection('tool:write')).toBeUndefined()
  })

  it('contributes nothing while the document is absent or has no such subject', async () => {
    const dir = await tempDir()
    const { sections, reflection } = await harness({ docPath: join(dir, 'absent.md') })

    expect(sections[0]?.text()).toBe('')
    expect(reflection('tool:read')).toBeUndefined()
  })

  it('re-reads the document once it changes on disk', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    await writeFile(docPath, '## tool:read\n第一版。', 'utf8')
    const { sections, reflection } = await harness({ docPath })
    expect(reflection('tool:read')).toContain('第一版。')

    // 后台子代理重写文档之后，下一次装配就该看到新版本，不需要重启。
    await writeFile(docPath, '## tool:read\n第二版，长一些。', 'utf8')
    expect(reflection('tool:read')).toContain('第二版，长一些。')
    expect(sections[0]?.text()).toBe('')
  })

  it('caps one subject\'s lessons so a chatty ability cannot crowd out the rest', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    await writeFile(docPath, `## tool:read\n${'x'.repeat(2000)}最后一条。`, 'utf8')
    const { reflection } = await harness({ docPath, maxSubjectChars: 200 })

    const text = reflection('tool:read') ?? ''
    // 截尾而不是截头：经验是按时间累积的，被丢掉的那头才是过时的。
    expect(text).toContain('最后一条。')
    expect(text.length).toBeLessThan(400)
  })
})
