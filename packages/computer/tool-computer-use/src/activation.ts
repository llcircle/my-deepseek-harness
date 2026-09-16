/**
 * 电脑操作的启用判定：从"用户说了什么"推导"要不要把桌面能力交给模型"。
 *
 * 判定只看人类输入（`source.kind === 'user'`）。插件注入的通知、工具结果、
 * 以及模型自己的输出都不得触发启用——否则一次截图结果的文本里出现"操作电脑"
 * 就能把能力打开，那等于让屏幕内容自己给自己授权。
 *
 * @module @deepseek-ai/dsh-tool-computer-use/activation
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { COMPUTER_COMMAND_ALIASES, COMPUTER_COMMAND_NAME } from './prompt.ts'

/**
 * 从进入本步的消息里取出人类输入文本。
 *
 * 只收 `source.kind === 'user'` 的消息：别的来源（插件通知、工具结果）
 * 携带的文本不构成用户意图。
 *
 * @param messages - 本步认领的消息。
 * @returns 按消息顺序拼接的纯文本；没有人类输入时是空字符串。
 */
export function collectUserText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 判断一段用户文本是否以电脑操作斜杠命令开头。
 *
 * 命令适配器会先处理 `/<name>` 形式，这里的判定是兜底：
 * 某些入口把整行原样交给模型，那时 `/computer` 仍应被认出来。
 *
 * @param text - 人类输入文本。
 * @returns 命中命令名或别名时为 true。
 */
export function hasCommandToken(text: string): boolean {
  const names = [COMPUTER_COMMAND_NAME, ...COMPUTER_COMMAND_ALIASES]
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('/')) continue
    const body = trimmed.slice(1)
    const separator = body.search(/[\s]/u)
    const name = (separator === -1 ? body : body.slice(0, separator)).toLowerCase()
    if (names.includes(name)) return true
  }
  return false
}

/**
 * 判断用户文本是否要求操作电脑。
 *
 * @param text - 人类输入文本。
 * @param phrases - 触发短语表；调用方可以在部署配置里追加。
 * @returns 命中任一触发条件时为 true。
 */
export function matchesTrigger(text: string, phrases: readonly string[]): boolean {
  if (text.trim() === '') return false
  if (hasCommandToken(text)) return true
  const haystack = text.toLowerCase()
  return phrases.some((phrase) => {
    const needle = phrase.trim().toLowerCase()
    return needle !== '' && haystack.includes(needle)
  })
}
