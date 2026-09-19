/**
 * 反思文档的按主题切分与重组。
 *
 * ## 为什么按主题切
 *
 * 反思文档原来是一整份"放之四海皆准"的经验，注入成独立的一节
 * （`deployment:error-lessons`）。可经验天然是**属于某个能力**的：`read` 的
 * 失败教训对 `mcp__github__search` 毫无用处，而模型在调用某个工具时最需要的
 * 恰恰是"上次调用它踩了什么坑"。所以文档改用 `## <主题>` 标题把经验分给具体的
 * 工具、MCP 服务器或电脑操作，装配时再追加到那个能力自己的分段后面。
 *
 * 主题键大多就是**提示词分段名**（`tool:read`、`mcp:github`、`computer:policy`），
 * 这样注入侧只要拿分段名查表即可，不需要第二套命名。
 *
 * ## MCP 工具为什么是例外
 *
 * 一个 MCP 服务器在提示词里只有一节，但它的每个工具在本文档里**各占一个主题**，
 * 键就是模型看到的公开工具名（`mcp__<服务器>__<工具>`）。折叠成服务器键看着整齐，
 * 代价却是模型和用户都分不清"这条经验是哪个工具的坑"：同一个服务器的十几个工具
 * 共用一格，编辑界面上改一处等于改全部。这些主题于是挂在服务器分段名下——注入时
 * 按 `### <工具>` 小结追加到 `mcp:<服务器>` 那一节，服务器自己的经验排在最前
 * （见 `@deepseek-ai/dsh-error-reflection-prompt`）。
 *
 * ## 认不出来的标题怎么办
 *
 * 归入"全局"部分，仍然按老办法整段注入。历史文档里的小节标题是日期
 * （`## 2026-09-13`），升级格式不该让这些经验凭空消失；用户手写的通用备注也不需要
 * 硬塞进某个能力。判定规则是确定性的——**只有长得像主题的标题才算主题**：以
 * `tool:`/`mcp:`/`computer:` 开头，或 `mcp__<server>__<工具>` 这种 MCP 公开工具名。
 *
 * @module @deepseek-ai/dsh-tool-error-journal/reflections
 */

/** 主题键的合法前缀。 */
const SUBJECT_PREFIXES = ['tool:', 'mcp:', 'computer:'] as const

/**
 * MCP 公开工具名 `mcp__<server>__<raw>`；`server` 与 mcp-client 的 `serverName` 同规则。
 *
 * 工具名部分要求非空：`mcp__github__` 没有主语，和 `tool:` 一样不算主题。
 */
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]{1,32}__.+$/

/**
 * 一个 MCP 服务器的工具主题前缀。
 *
 * 按前缀认领而不是把主题拆成"服务器 + 工具"再比较：`serverName` 和工具名都允许
 * 出现下划线（`mcp__my-server_2__create_issue`），从公开名反推哪一段是服务器名是
 * 有歧义的。反过来从已知的服务器名拼前缀，则永远只有一种读法。
 *
 * @param serverName - mcp-client 的 `serverName`。
 * @returns 形如 `mcp__github__` 的主题前缀。
 */
export function mcpToolSubjectPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

/** 一个 Markdown 二级标题行。 */
const HEADING = /^##[ \t]+(.+?)[ \t]*$/

/** 一条归属某个主题的反思。 */
export interface ReflectionSubjectBlock {
  /** 主题键，等于目标提示词分段名。 */
  readonly subject: string
  /** 该主题的经验正文；空串表示这条经验已被清空。 */
  readonly text: string
}

/** 解析后的反思文档。 */
export interface ReflectionDocument {
  /** 没有被任何主题认领的部分（前言、历史日期小节、通用备注），原样保留。 */
  readonly global: string
  /** 主题键 → 经验正文；同一主题出现多次时以最后一次为准。 */
  readonly subjects: ReadonlyMap<string, string>
}

/**
 * 把一个小节标题归一化成主题键。
 *
 * @param heading - `## ` 之后的标题文本。
 * @returns 主题键；标题不像主题时返回 `undefined`（调用方按全局处理）。
 */
export function normalizeReflectionSubject(heading: string): string | undefined {
  const key = heading.trim()
  if (key === '') return undefined
  // MCP 公开工具名原样成键：它已经是模型眼里的名字，再折叠成服务器键就会让同一
  // 服务器下十几个工具的经验挤进同一格——看得见来源、单独改，比"整齐"重要。
  if (MCP_TOOL_NAME.test(key)) return key
  for (const prefix of SUBJECT_PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) return key
  }
  return undefined
}

/**
 * 把文档切成"全局部分 + 各主题的经验"。
 *
 * 主题小节的正文不含标题行本身；上下空白被裁掉。认不出主题的小节与所有非小节
 * 文本一并进入 {@link ReflectionDocument.global}，保持原样。
 *
 * @param raw - 反思文档原文。
 * @returns 切分结果；空文档返回空全局与空表。
 */
export function parseReflectionDocument(raw: string): ReflectionDocument {
  const globalLines: string[] = []
  const subjects = new Map<string, string>()
  let open: { subject: string; lines: string[] } | undefined
  const close = (): void => {
    if (open === undefined) return
    // 同一主题写两次时后一处覆盖前一处：文档是机器写的，出现重复就是修订，
    // 不是"两条经验"。
    subjects.set(open.subject, open.lines.join('\n').trim())
    open = undefined
  }
  for (const line of raw.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      close()
      const subject = normalizeReflectionSubject(heading[1] as string)
      if (subject === undefined) globalLines.push(line)
      else open = { subject, lines: [] }
      continue
    }
    if (open === undefined) globalLines.push(line)
    else open.lines.push(line)
  }
  close()
  return { global: globalLines.join('\n').trim(), subjects }
}

/** 文档里的一"区"：一个主题小节，或一段不属于任何主题的连续文本。 */
interface Zone {
  /** 主题键；`undefined` 表示这是全局区（前言、认不出的标题及其正文）。 */
  readonly subject: string | undefined
  /** 区内的原始行；主题区含原始标题行，正文原样。 */
  readonly lines: readonly string[]
}

/** 按标题边界把文档切成区。 */
function zonesOf(raw: string): Zone[] {
  const zones: Zone[] = []
  let subject: string | undefined
  let lines: string[] = []
  for (const line of raw.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading === null) {
      lines.push(line)
      continue
    }
    zones.push({ subject, lines })
    subject = normalizeReflectionSubject(heading[1] as string)
    // 标题原文一并留着：没被点名的区要整块原样吐回去，包括它原始的标题写法
    // （认不出的标题会进"全局"区，那里的字一个都不该被我们改写）。
    lines = [line]
  }
  zones.push({ subject, lines })
  return zones
}

/**
 * 按主题原位改写文档：已有的主题小节就地替换（清空则整节删除），新主题追加到末尾，
 * 其余内容逐字保留。
 *
 * 原位而不是"重新序列化"是有意的：文档里还躺着认不出主题的历史小节和用户备注，
 * 每次编辑界面保存都把它们重排一遍，会让人再也认不出自己的文档。改写只动区与区
 * **之间**的空白，区内的换行、缩进、代码块一律不碰。
 *
 * @param raw - 反思文档原文。
 * @param blocks - 要写入的主题经验；`text` 为空白表示删除该主题。
 * @returns 改写后的完整文档（总以单个换行结尾）。
 */
export function replaceReflectionBlocks(
  raw: string,
  blocks: readonly ReflectionSubjectBlock[],
): string {
  const pending = new Map(blocks.map(block => [block.subject, block.text.trim()]))
  const segments: string[] = []
  for (const zone of zonesOf(raw)) {
    if (zone.subject === undefined) {
      const text = zone.lines.join('\n').trim()
      if (text !== '') segments.push(text)
      continue
    }
    const text = pending.get(zone.subject)
    if (text === undefined) {
      // 这次没改这个主题：整区连原始标题一起原样留着。
      segments.push(zone.lines.join('\n').trim())
      continue
    }
    pending.delete(zone.subject)
    if (text !== '') segments.push(`## ${zone.subject}\n\n${text}`)
  }
  for (const [subject, text] of pending) {
    if (text !== '') segments.push(`## ${subject}\n\n${text}`)
  }
  return segments.length === 0 ? '' : `${segments.join('\n\n')}\n`
}

/**
 * 读取一条主题的反思；未记录或已被清空时返回空串。
 * @param document - 已解析的文档。
 * @param subject - 主题键。
 * @returns 该主题的经验正文。
 */
export function reflectionOf(document: ReflectionDocument, subject: string): string {
  return document.subjects.get(subject)?.trim() ?? ''
}
