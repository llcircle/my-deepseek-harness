/**
 * The `/translate-system-prompt` command: a user-invoked locale archive of the
 * exact system prompt the receiving agent assembles — the deployment's
 * injected prompt. The handler assembles the agent-scoped prompt through the
 * system-prompt service, renders it, and starts ONE background one-shot
 * subagent whose prompt carries the original text and orders it to translate
 * the whole text into the target locale and write a bilingual markdown
 * archive (original plus translation). The command runs no model work itself;
 * the child runs independently of the main conversation.
 *
 * @module @deepseek-ai/dsh-command-translate-system-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
// Type-only: pulls the ctx.commands, ctx.systemPrompt, and ctx.subagents merges.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'command-translate-system-prompt'

/** Plugin configuration. */
export interface Config {
  /** Archive file the child writes; relative to the child's workspace. */
  archivePath?: string
  /**
   * Translation-only file the child writes beside the archive; feed this path
   * to system-prompt's `completePromptFile` to make the model receive the
   * translated prompt. Relative to the child's workspace.
   */
  promptOnlyPath?: string
  /** Target locale BCP-47 tag for the translation. */
  targetLocale?: string
  /** Subagent provider that runs the translation child. */
  provider?: string
}

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  archivePath: z.string().min(1).default('.dsh/system-prompt.zh.md'),
  promptOnlyPath: z.string().min(1).default('.dsh/system-prompt.zh.prompt.md'),
  targetLocale: z.string().min(1).default('zh'),
  provider: z.string().min(1).default('spawn'),
})

/** Resolve and validate configuration; misconfiguration fails at load. */
export function resolveConfig(config: Config): {
  archivePath: string
  promptOnlyPath: string
  targetLocale: string
  provider: string
} {
  return {
    archivePath: config.archivePath ?? '.dsh/system-prompt.zh.md',
    promptOnlyPath: config.promptOnlyPath ?? '.dsh/system-prompt.zh.prompt.md',
    targetLocale: config.targetLocale ?? 'zh',
    provider: config.provider ?? 'spawn',
  }
}

/** Build the child's prompt: bilingual archive instructions plus the original text. */
export function buildTranslationPrompt(
  original: string,
  archivePath: string,
  promptOnlyPath: string,
  targetLocale: string,
): ContentBlock[] {
  const text = [
    'You are archiving the agent\'s system prompt in two languages.',
    `Translate the ORIGINAL text below into locale \`${targetLocale}\` — natural, concise, technical terms kept recognizable; keep {{variable}} placeholders, tool names, and code unchanged.`,
    'Translate the WHOLE original; do not add commentary, summaries, or opinions.',
    'Then WRITE TWO files with your write tool.',
    `File 1 — the bilingual markdown archive to ${archivePath} with EXACTLY two content sections:`,
    '1. A `## Original` section containing the ORIGINAL text verbatim and unmodified.',
    `2. A \`## ${targetLocale}\` section containing the full translation.`,
    `File 2 — the TRANSLATION ONLY to ${promptOnlyPath}: exactly the full translated text with no headings, no original text, and no commentary. This file is consumed verbatim as a system prompt.`,
    'Create parent directories via the write tool.',
    'Finish by replying with both paths and one sentence on what was translated.',
    '',
    'ORIGINAL:',
    original,
  ].join('\n')
  return [{ type: 'text', text }]
}

/** Register the command when the command registry is composed. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'translate-system-prompt',
      description: 'Start a background child that translates the current system prompt into the bilingual archive file.',
      handler: async ({ agent, signal }) => {
        const systemPrompt = ctx.get('systemPrompt')
        if (systemPrompt === undefined) {
          return { kind: 'error', text: 'translate-system-prompt requires the system-prompt service; mount @deepseek-ai/dsh-system-prompt' }
        }
        const subagents = ctx.get('subagents')
        if (subagents === undefined) {
          return { kind: 'error', text: 'translate-system-prompt requires a subagent runtime; mount @deepseek-ai/dsh-subagent with a provider backend' }
        }
        let promptText: string
        try {
          const assembly = await systemPrompt.assemble({ agent, scope: agent, signal })
          promptText = renderPrompt(assembly)
        } catch (error) {
          return { kind: 'error', text: `translate-system-prompt could not assemble the system prompt: ${String(error)}` }
        }
        if (promptText.trim() === '') {
          return { kind: 'success', text: 'The assembled system prompt is empty; nothing to translate.' }
        }
        const cwd = agent.session.header.cwd
        if (cwd === undefined) {
          return { kind: 'error', text: 'translate-system-prompt requires a session with a working directory' }
        }
        const archivePath = isAbsolute(resolved.archivePath)
          ? resolved.archivePath
          : join(cwd, resolved.archivePath)
        const promptOnlyPath = isAbsolute(resolved.promptOnlyPath)
          ? resolved.promptOnlyPath
          : join(cwd, resolved.promptOnlyPath)
        try {
          const run = await subagents.start(resolved.provider, {
            label: 'system-prompt-translation',
            prompt: buildTranslationPrompt(promptText, archivePath, promptOnlyPath, resolved.targetLocale),
            parent: agent,
            signal,
          })
          return {
            kind: 'success',
            text: `Translation child ${String(run.id)} started in the background; it will write the bilingual archive to ${archivePath} and the translation-only prompt to ${promptOnlyPath} (${resolved.targetLocale}). Track it on the subagent surface.`,
          }
        } catch (error) {
          return { kind: 'error', text: `translate-system-prompt could not start the translation child: ${String(error)}` }
        }
      },
    })
  })
}
