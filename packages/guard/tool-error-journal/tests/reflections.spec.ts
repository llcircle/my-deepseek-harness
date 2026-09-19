/**
 * 反思文档的按主题切分与重组。
 *
 * 这里守的是两件事：
 *
 * 1. **认主题要确定。** 主题键必须就是提示词分段名，否则注入侧要把同一套命名
 *    再翻译一遍。唯一的例外是 MCP 工具：一个服务器只有一节提示词，工具却各有
 *    自己的坑，所以公开工具名（`mcp__github__search`）原样成键，各自占一格——
 *    折叠成服务器键会让十几个工具的经验挤在一起，看得见来源比整齐重要。认不出
 *    主题的标题（历史日期小节、用户手写备注）一律算"全局"，仍然整段注入：升级
 *    格式不能让已经躺在磁盘上的经验消失。
 * 2. **改写要原位。** 界面只编辑它显示过的那几条主题，别的内容逐字保留；"重新
 *    序列化整份文档"会把用户认得出的小节重排成他认不出的样子。
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeReflectionSubject,
  parseReflectionDocument,
  reflectionOf,
  replaceReflectionBlocks,
} from '../src/reflections.ts'

describe('normalizeReflectionSubject', () => {
  it('accepts the three subject families verbatim', () => {
    expect(normalizeReflectionSubject('tool:read')).toBe('tool:read')
    expect(normalizeReflectionSubject('mcp:github')).toBe('mcp:github')
    expect(normalizeReflectionSubject('computer:policy')).toBe('computer:policy')
  })

  it('keeps an MCP public tool name as its own subject', () => {
    // 不折叠成 `mcp:github`：同一个服务器的工具要能各写各的经验。
    expect(normalizeReflectionSubject('mcp__github__search')).toBe('mcp__github__search')
    expect(normalizeReflectionSubject('mcp__my-server_2__create_issue')).toBe('mcp__my-server_2__create_issue')
    // 工具名里再带下划线也一样原样留着——从公开名反推哪一段是服务器名本来就有歧义，
    // 所以根本不反推。
    expect(normalizeReflectionSubject('mcp__gh__search__inner')).toBe('mcp__gh__search__inner')
  })

  it('treats anything else as global', () => {
    // 历史文档的小节标题是日期，用户备注更是随便写；它们都不该被硬塞进某个能力。
    expect(normalizeReflectionSubject('2026-09-08')).toBeUndefined()
    expect(normalizeReflectionSubject('通用')).toBeUndefined()
    // 只有前缀没有名字，等于没有主语。
    expect(normalizeReflectionSubject('tool:')).toBeUndefined()
    expect(normalizeReflectionSubject('mcp__github__')).toBeUndefined()
    expect(normalizeReflectionSubject('   ')).toBeUndefined()
  })
})

describe('parseReflectionDocument', () => {
  it('separates the global part from the subject blocks', () => {
    const raw = [
      '这是一段前言。',
      '',
      '## 2026-09-08',
      '历史经验。',
      '',
      '## tool:read',
      '读大文件先看行数。',
      '',
      '## mcp__github__search',
      '仓库名要带 owner。',
    ].join('\n')

    const document = parseReflectionDocument(raw)

    expect(document.global).toContain('这是一段前言。')
    expect(document.global).toContain('## 2026-09-08')
    expect(document.global).toContain('历史经验。')
    expect([...document.subjects]).toEqual([
      ['tool:read', '读大文件先看行数。'],
      ['mcp__github__search', '仓库名要带 owner。'],
    ])
    expect(reflectionOf(document, 'tool:write')).toBe('')
    expect(reflectionOf(document, 'mcp:github')).toBe('')
  })

  it('keeps the last block when a subject is written twice', () => {
    const document = parseReflectionDocument('## tool:read\n旧的。\n## tool:read\n新的。')
    expect(reflectionOf(document, 'tool:read')).toBe('新的。')
  })

  it('parses an absent document as empty', () => {
    const document = parseReflectionDocument('')
    expect(document.global).toBe('')
    expect(document.subjects.size).toBe(0)
  })
})

describe('replaceReflectionBlocks', () => {
  const original = [
    '手写前言。',
    '',
    '## 2026-09-08',
    '历史经验，别动我。',
    '',
    '## tool:read',
    '旧的读文件经验。',
    '',
    '## tool:write',
    '写文件要先确认路径。',
  ].join('\n')

  it('rewrites only the named subjects and leaves everything else byte for byte', () => {
    const next = replaceReflectionBlocks(original, [{ subject: 'tool:read', text: '新的读文件经验。' }])

    expect(next).toContain('手写前言。')
    expect(next).toContain('## 2026-09-08\n历史经验，别动我。')
    // 没被点名的主题连原始标题一起原样留着——连"这一节里有没有空行"都不改。
    expect(next).toContain('## tool:write\n写文件要先确认路径。')
    expect(next).toContain('## tool:read\n\n新的读文件经验。')
    expect(next).not.toContain('旧的读文件经验。')
  })

  it('rewrites an MCP tool block under its own heading', () => {
    // 归一化后键就是原来的标题，于是"改写"就是把正文换掉——不再折叠成服务器标题。
    const next = replaceReflectionBlocks('## mcp__github__search\n旧的。', [
      { subject: 'mcp__github__search', text: '新的。' },
    ])
    expect(next).toBe('## mcp__github__search\n\n新的。\n')
  })

  it('appends a subject the document never had', () => {
    const next = replaceReflectionBlocks('## tool:read\n读文件。', [
      { subject: 'tool:write', text: '写文件。' },
    ])
    expect(next).toBe('## tool:read\n读文件。\n\n## tool:write\n\n写文件。\n')
  })

  it('removes a subject when its text is cleared', () => {
    const next = replaceReflectionBlocks(original, [{ subject: 'tool:read', text: '   ' }])
    expect(next).not.toContain('tool:read')
    expect(next).toContain('tool:write')
    expect(next).toContain('2026-09-08')
  })

  it('preserves the interior of a block, including blank lines', () => {
    const body = '第一条。\n\n\n第二条（故意空两行）。'
    const next = replaceReflectionBlocks('## tool:read\n旧的。', [{ subject: 'tool:read', text: body }])
    // 只有"区与区之间"的空白会被规整，区内的换行是用户写的，不能碰。
    expect(next).toBe(`## tool:read\n\n${body}\n`)
  })

  it('serializes an emptied document as an empty string', () => {
    expect(replaceReflectionBlocks('## tool:read\n读文件。', [{ subject: 'tool:read', text: '' }])).toBe('')
  })
})
