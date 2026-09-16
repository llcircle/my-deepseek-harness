/**
 * 工具失败的三份文档，以及它们的读取入口。
 *
 * 三份文档分工明确：
 *
 * - **日志**（`tool-error-log.jsonl`）：每次失败实时追加，是"刚刚发生了什么"。
 *   它被反复清空，所以不能当作历史——它只是一段待处理的收件箱。写入它的只有
 *   {@link import('./index.ts').apply} 里的 `session/event` 监听。
 * - **归档**（`tool-error-log-archive.jsonl`）：只追加，从不重写。`/correct-errors`
 *   在清空日志之前把日志原文整段倒进来，于是所有失败都有据可查。这个名字与命令
 *   共用同一个账本：两条入口不能各写各的文件。
 * - **反思**（`error-reflections.md`）：面向模型的经验文档，由 `/correct-errors`
 *   融合日志与上一版反思后重写，再由 `@deepseek-ai/dsh-error-reflection-prompt`
 *   注入。文档按主题分节（`## tool:read`、`## mcp:github`、`## computer:policy`），
 *   切分规则见 `./reflections.ts`：每一节追加到同名提示词分段之后，认不出主题的
 *   部分仍作为一整节注入。
 *
 * 本模块只提供路径解析与读写原语；融合、归档、清空是
 * `@deepseek-ai/dsh-command-correct-errors` 的职责，这里不重复实现一遍。
 *
 * 三者都放在 Harness home 下（`$DSH_HOME` 或 `~/.dsh`）：反思是系统级文档，
 * 不随会话或项目走。
 *
 * @module @deepseek-ai/dsh-tool-error-journal/documents
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Default file name of the live failure journal, relative to the Harness home. */
export const DEFAULT_TOOL_ERROR_LOG_FILE = 'tool-error-log.jsonl'

/** Default file name of the append-only failure archive, relative to the Harness home. */
export const DEFAULT_TOOL_ERROR_ARCHIVE_FILE = 'tool-error-log-archive.jsonl'

/** Default file name of the model-facing reflection document, relative to the Harness home. */
export const DEFAULT_ERROR_REFLECTIONS_FILE = 'error-reflections.md'

/** One journaled failure, serialized as one JSONL line. */
export interface ToolErrorEntry {
  /** ISO timestamp of the committed result event. */
  readonly time: string
  /** Session that owns the failed call. */
  readonly sessionId: string
  /** Sequence number of the `tool/result` record. */
  readonly seq: number
  /** Tool name learned from the paired `tool/call` record; `unknown` when none was seen. */
  readonly name: string
  /** Model-facing call identity. */
  readonly callId: string
  /** Internal failure identity when the envelope carried one. */
  readonly internalError?: { readonly name: string; readonly code: string }
  /** Model-facing failure text, capped at `maxTextChars`. */
  readonly text: string
}

/** Absolute locations of the three failure documents. */
export interface ToolErrorDocumentPaths {
  /** Live journal the failure tap appends to. */
  readonly log: string
  /** Append-only history `/correct-errors` copies the journal into. */
  readonly archive: string
  /** Model-facing reflection document `/correct-errors` rewrites. */
  readonly reflections: string
}

/** Per-document file-name overrides for {@link resolveToolErrorDocuments}. */
export interface ToolErrorDocumentFiles {
  /** File name (or absolute path) of the live journal. */
  readonly log?: string
  /** File name (or absolute path) of the append-only archive. */
  readonly archive?: string
  /** File name (or absolute path) of the reflection document. */
  readonly reflections?: string
}

/**
 * Resolve the three failure documents under one directory.
 *
 * 日志插件用自己的 `Config.path` 决定目录，读文档的一方（配置界面）不传参数而
 * 落到默认目录。两者只有在部署主动搬走了日志插件时才会分叉；那种部署必须同时
 * 把配置界面指到同一个目录，否则界面会诚实地报告"没有记录到失败"。
 *
 * @param directory - directory holding the documents; defaults to the Harness home.
 * @param files - per-document file-name overrides, each relative to `directory`
 * unless absolute.
 * @returns the absolute path of each document.
 */
export function resolveToolErrorDocuments(
  directory: string = resolveDshHome(),
  files: ToolErrorDocumentFiles = {},
): ToolErrorDocumentPaths {
  return {
    log: join(directory, files.log ?? DEFAULT_TOOL_ERROR_LOG_FILE),
    archive: join(directory, files.archive ?? DEFAULT_TOOL_ERROR_ARCHIVE_FILE),
    reflections: join(directory, files.reflections ?? DEFAULT_ERROR_REFLECTIONS_FILE),
  }
}

/**
 * Read the live journal, skipping lines that are not valid JSON.
 *
 * 一行坏数据不该让整个界面报错：日志是"尽力记录"的产物，写入被强杀、磁盘写满
 * 都可能留下半行。解析不了的行走丢，能解析的照常返回。
 *
 * @param path - absolute journal path.
 * @returns parsed entries in file order; empty when the file does not exist.
 */
export async function readToolErrorJournal(path: string): Promise<ToolErrorEntry[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  const entries: ToolErrorEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as ToolErrorEntry)
    } catch {
      continue
    }
  }
  return entries
}

/**
 * Read the reflection document.
 * @param path - absolute document path.
 * @returns the document text; empty when it does not exist.
 */
export async function readErrorReflections(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Replace the reflection document, creating its directory when needed. This is
 * the manual-edit path: `/correct-errors` writes the same file from the child.
 * @param path - absolute document path.
 * @param text - the complete document to store.
 */
export async function writeErrorReflections(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}
