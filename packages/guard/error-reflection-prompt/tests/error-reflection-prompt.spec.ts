/**
 * The error-reflection-prompt plugin: resolves its document path under the
 * Harness home, contributes no text for an absent or empty document, cuts a
 * capped tail on a heading boundary, and — the part that carries the feature —
 * routes each `## <主题>` section of the document to the prompt section of the
 * same name instead of dumping every lesson into one global pile.
 *
 * MCP tools have no section of their own, so they land in their server's
 * section as `### <tool>` blocks — one per tool, in tool-name order, behind the
 * server's own lessons, each capped on its own.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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
  ctx: Context
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
  await ctx.plugin(FakeSystemPrompt)
  await ctx.plugin(ReflectionPrompt, options)
  return { ctx, sections, reflection: name => reflection(name) }
}

/**
 * 触发一次压缩边界。
 *
 * 闸门是**部署级**语义——文档与承接它的分段都是全局的，所以"哪一次压缩触发的换新"
 * 无关紧要；这里给一个占位会话语境就够了，那也正是被测代码读不到它的原因。
 */
function compact(ctx: Context): void {
  ctx.emit('session/event', undefined as unknown as Session, {
    type: 'compaction/end',
    data: { compactionId: CompactionId('test'), turn: null },
  } as SessionEvent)
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
    // MCP 工具没有自己的分段，经验落到它服务器的分段里，按 `### <工具>` 分块。
    expect(reflection('mcp:github')).toContain('### search')
    expect(reflection('mcp:github')).toContain('仓库名要带 owner。')
    expect(reflection('computer:policy')).toContain('坐标先截图确认。')
    // 没有对应分段的主题不产出文本——它会在装配时被直接丢掉。
    expect(reflection('tool:write')).toBeUndefined()
    // 工具主题自己也是一条主题，直接问它答的是它自己的经验；只是现场没有这个分段，
    // 装配时不会有人这么问。`### ` 分块是服务器分段才有的排版，这里不该出现。
    expect(reflection('mcp__github__search')).toContain('仓库名要带 owner。')
    expect(reflection('mcp__github__search')).not.toContain('### ')
  })

  it('puts a server\'s own lessons ahead of its tools, one block per tool', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    // 故意把工具写在服务器前面：注入顺序该由我们决定，不该跟着文档的书写顺序走。
    await writeFile(docPath, [
      '## mcp__github__create_issue',
      '先确认仓库存在。',
      '',
      '## mcp__github__search',
      '仓库名要带 owner。',
      '',
      '## mcp:github',
      '这个服务器要 token。',
      '',
      '## mcp__gitlab__search',
      '别人的服务器，不许混进来。',
    ].join('\n'), 'utf8')
    const { reflection } = await harness({ docPath })

    const text = reflection('mcp:github') ?? ''
    expect(text.indexOf('这个服务器要 token。')).toBeLessThan(text.indexOf('### create_issue'))
    expect(text.indexOf('### create_issue')).toBeLessThan(text.indexOf('### search'))
    // 只有一份抬头：整节一份，不是每个工具各来一份。
    expect(text.match(/以下(是|从)/g)?.length).toBe(1)
    // 前缀匹配是精确到服务器名的，`gitlab` 的工具不该被 `github` 那一节认领。
    expect(text).not.toContain('别人的服务器')
    expect(reflection('mcp:gitlab')).toContain('别人的服务器')
  })

  it('caps each tool\'s lessons on its own, not the composed section', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    await writeFile(docPath, [
      `## mcp__gh__first\n${'x'.repeat(2000)}第一条的尾巴。`,
      '',
      `## mcp__gh__second\n${'y'.repeat(2000)}第二条的尾巴。`,
    ].join('\n'), 'utf8')
    const { reflection } = await harness({ docPath, maxSubjectChars: 200 })

    const text = reflection('mcp:gh') ?? ''
    // 一个话多的工具挤掉的该是它自己的前半段，而不是排在它后面的那个工具。
    expect(text).toContain('第一条的尾巴。')
    expect(text).toContain('第二条的尾巴。')
    expect(text).toContain('### first')
    expect(text).toContain('### second')
  })

  it('contributes nothing while the document is absent or has no such subject', async () => {
    const dir = await tempDir()
    const { sections, reflection } = await harness({ docPath: join(dir, 'absent.md') })

    expect(sections[0]?.text()).toBe('')
    expect(reflection('tool:read')).toBeUndefined()
  })

  it('admits exactly one change per compaction boundary', () => {
    const gate = new ReflectionPrompt.ReflectionRefreshGate()
    expect(gate.take()).toBe(false)
    gate.markBoundary()
    expect(gate.take()).toBe(true)
    // 一次边界只放行一次：换新已经发生过，再改还要等下一次压缩。
    expect(gate.take()).toBe(false)
  })

  it('keeps serving the last parse until a compaction boundary admits the change', async () => {
    const dir = await tempDir()
    const docPath = join(dir, 'reflections.md')
    await writeFile(docPath, '## tool:read\n第一版。', 'utf8')
    const { ctx, sections, reflection } = await harness({ docPath })
    expect(reflection('tool:read')).toContain('第一版。')

    // 学习途中落盘的重写不在当轮生效：分段排在请求头部，中途换新会把整个会话的
    // 缓存前缀作废。此时仍按上一次的快照作答——磁盘上已经不是第一版了。
    await writeFile(docPath, '## tool:read\n第二版，长一些。', 'utf8')
    expect(reflection('tool:read')).toContain('第一版。')
    expect(sections[0]?.text()).toBe('')

    // 压缩是缓存本来就要重建的时刻，换新在这里放行。
    compact(ctx)
    expect(reflection('tool:read')).toContain('第二版，长一些。')

    await writeFile(docPath, '## tool:read\n第三版。', 'utf8')
    expect(reflection('tool:read')).toContain('第二版，长一些。')
    compact(ctx)
    expect(reflection('tool:read')).toContain('第三版。')
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
