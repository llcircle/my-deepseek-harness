/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: makes the optional `ctx.get('systemPrompt')` service available, the
// same way the section providers resolve the request's language.
import type { PromptLocale } from '@deepseek-ai/dsh-system-prompt'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 *
 * 两份文案按本次装配的语言选取，与 `tools:sdk` 的散文、`mcp:<server>` 的介绍段
 * 是同一条来源（{@link SystemPrompt.activeLocale}），所以中文部署拿到的检查点
 * 也是中文的。换语言不会击穿缓存：这段指令是重放前缀**之后**追加的最后一条消息，
 * 本就不在可复用的前缀里。小节标题保持英文——它们是结构契约，也要能与更早的
 * 英文检查点合并成同一套结构。
 */
const COMPACTION_INSTRUCTIONS: Record<PromptLocale, string> = {
  en: [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
    '',
    '## Key Technical Concepts',
    '- [technologies, frameworks, patterns, and conventions in play]',
    '',
    '## Files and Code',
    '- [exact path: why it matters, key changes or snippets]',
    '',
    '## Errors and Fixes',
    '- [error: how it was resolved, plus any related user feedback]',
    '',
    '## Pending Jobs',
    '- [explicitly requested work not yet completed]',
    '',
    '## Current Work',
    '- [precisely what was in progress at this checkpoint]',
    '',
    '## Next Step',
    '- [the single next action, directly in line with the most recent request, or "(none)"]',
    '',
    '## Critical Context',
    '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
    '',
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
    `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
  ].join('\n'),
  zh: [
    '你现在是本 AI 编程助手的上下文压缩引擎。请把上面的对话浓缩成一份结构化检查点，让另一个模型能在不丢失关键上下文的前提下接手这项工作。',
    '',
    '严格按下面给出的 Markdown 结构输出：每个小节都必须保留、顺序不变。用简短的条目，不要写成整段散文。某一节没有内容时写 "(none)"——任何一节都不许省略。',
    '',
    '## Primary Request and Intent',
    '- [用户最初以及后来演变的目标；措辞本身重要时请原文照录]',
    '',
    '## Key Technical Concepts',
    '- [涉及的技术、框架、模式和约定]',
    '',
    '## Files and Code',
    '- [确切路径：为什么重要、关键改动或代码片段]',
    '',
    '## Errors and Fixes',
    '- [错误：如何解决的，以及相关的用户反馈]',
    '',
    '## Pending Jobs',
    '- [用户明确要求但尚未完成的工作]',
    '',
    '## Current Work',
    '- [此刻正做到哪一步]',
    '',
    '## Next Step',
    '- [紧接最近一次请求的下一步动作，或 "(none)"]',
    '',
    '## Critical Context',
    '- [决策及其理由、约束、用户偏好、待定问题、继续所需的数据]',
    '',
    '规则：',
    '- 用简洁的中文工程语言书写，但要原样保留文件路径、命令、错误字符串、标识符、数值、函数签名与语法片段。',
    '- 忠实记录用户反馈与明确指令，尤其是纠正意见。',
    '- 不要提及这次总结请求，也不要提及上下文曾被压缩。',
    '- 只输出检查点文本：不要调用任何工具，也不要执行其他动作。',
    `- 如果对话里已经有一个 ${SUMMARY_OPEN_TAG} 块，那是更早的检查点。不要把它原样抄过来：保留仍然成立的事实，丢弃已经过时的，并把更新的信息合并进同一套结构下的单一汇总。`,
  ].join('\n'),
}

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  // 指令语言跟随本次装配的语言（与各提示词分段同一来源）；没有 systemPrompt
  // 服务（离线渲染、精简测试）时保持英文，与改动前一致。
  const locale = ctx.get('systemPrompt')?.activeLocale() ?? 'en'
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTIONS[locale] }],
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
