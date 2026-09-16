/**
 * 失败文档的路径解析与读取原语。
 *
 * 这里守住的是"一行坏数据不该让整个界面报错"这条底线：日志是尽力记录的产物，
 * 写入被强杀、磁盘写满都可能留下半行；解析不了的行走丢，能解析的照常返回。
 *
 * 融合、归档、清空不在这个包里——那是 `/correct-errors` 命令的职责，与之配套的
 * 契约由 `@deepseek-ai/dsh-command-correct-errors` 自己的测试守住。
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ERROR_REFLECTIONS_FILE,
  DEFAULT_TOOL_ERROR_ARCHIVE_FILE,
  readErrorReflections,
  readToolErrorJournal,
  resolveToolErrorDocuments,
  writeErrorReflections,
  type ToolErrorDocumentPaths,
  type ToolErrorEntry,
} from '../src/documents.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One isolated directory holding the three documents, as the plugin would resolve them. */
async function tempDocuments(): Promise<ToolErrorDocumentPaths> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-error-documents-'))
  tempDirs.push(dir)
  return resolveToolErrorDocuments(dir)
}

function entry(seq: number, text = 'drag 需要 fromX/fromY 作为起点'): ToolErrorEntry {
  return {
    time: '2026-09-08T04:27:40.566Z',
    sessionId: 'journal-session',
    seq,
    name: 'computer_drag',
    callId: `call-${String(seq)}`,
    text,
  }
}

function line(seq: number, text?: string): string {
  return JSON.stringify(entry(seq, text))
}

describe('resolving the failure documents', () => {
  it('puts all three beside each other under one directory', async () => {
    const documents = await tempDocuments()
    const parent = documents.log.slice(0, documents.log.length - documents.log.split(/[\\/]/u).at(-1)!.length)
    expect(documents.archive.startsWith(parent)).toBe(true)
    expect(documents.reflections.startsWith(parent)).toBe(true)
    // 归档与命令共用同一个账本：名字必须和 `/correct-errors` 完全一致。
    expect(documents.archive.endsWith(DEFAULT_TOOL_ERROR_ARCHIVE_FILE)).toBe(true)
    expect(documents.reflections.endsWith(DEFAULT_ERROR_REFLECTIONS_FILE)).toBe(true)
  })
})

describe('reading the failure journal', () => {
  it('skips rows that are not valid JSON instead of failing the whole read', async () => {
    const documents = await tempDocuments()
    await writeFile(documents.log, `${line(1)}\n{"half": \n${line(2)}\n`, 'utf8')
    expect((await readToolErrorJournal(documents.log)).map(item => item.seq)).toEqual([1, 2])
  })

  it('reports an empty journal for a missing file', async () => {
    const documents = await tempDocuments()
    expect(await readToolErrorJournal(documents.log)).toEqual([])
  })
})

describe('reading and replacing the reflection document', () => {
  it('reports an empty document before one exists', async () => {
    const documents = await tempDocuments()
    expect(await readErrorReflections(documents.reflections)).toBe('')
  })

  it('round-trips a manual edit and creates the directory on demand', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-error-documents-'))
    tempDirs.push(dir)
    const documents = resolveToolErrorDocuments(join(dir, 'nested', 'deeper'))
    expect(existsSync(documents.reflections)).toBe(false)

    await writeErrorReflections(documents.reflections, '# 经验\n\n- 调用 python.exe 要用绝对路径')
    expect(await readFile(documents.reflections, 'utf8')).toBe('# 经验\n\n- 调用 python.exe 要用绝对路径')
    expect(await readErrorReflections(documents.reflections)).toContain('绝对路径')
  })
})
