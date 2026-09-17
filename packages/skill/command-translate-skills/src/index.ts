/**
 * The `/translate-skills` command: a user-invoked locale pass over the skill
 * catalog. The handler reads every catalogued skill's description and optional
 * `whenToUse` from `ctx.skills.list()`, then starts ONE background one-shot
 * subagent whose prompt carries the entries and orders it to translate ONLY
 * those summaries into the target locale and write the archive JSON file
 * (default `.dsh/skill-translations.zh.json` in the workspace). Skill bodies
 * are never part of the prompt — descriptions only, exactly as scoped.
 *
 * @module @deepseek-ai/dsh-command-translate-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
// Type-only: pulls the ctx.agentPresets, ctx.commands, ctx.skills, and ctx.subagents merges.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'command-translate-skills'

/** Plugin configuration. */
export interface Config {
  /** Archive file the child writes; relative to the child's workspace. */
  archivePath?: string
  /**
   * Shared archive the child writes IN ADDITION to {@link archivePath}.
   * Relative paths resolve against the harness home; an empty string disables
   * the shared copy. It exists because skills live in a user-level registry:
   * without it a catalog translated for one workspace reads as untranslated in
   * every other one.
   */
  sharedArchivePath?: string
  /** Target locale BCP-47 tag for the translations. */
  targetLocale?: string
  /** Subagent provider that runs the translation child. */
  provider?: string
  /**
   * Tools the translation child keeps; every other inherited tool is removed.
   * Defaults to reading and writing — see {@link DEFAULT_CHILD_TOOLS}.
   */
  childTools?: string[]
  /**
   * Prompt sections the translation child does not get; defaults to deployment
   * identity, persona, and the error-lessons section. An empty list suppresses
   * nothing.
   */
  childOmitSections?: string[]
}

/**
 * Tools the translation child keeps.
 *
 * 提示词已经把每一条待译摘要都列全了，子 agent 不需要读技能文件——原文里没有
 * 技能正文，只有摘要。它要做的事就是**把一份 JSON 写到一到两个路径**，所以
 * `write` 是唯一真正必需的；保留 `read` 是为了让它能核对刚写下的文件。
 */
const DEFAULT_CHILD_TOOLS = ['read', 'write']

/**
 * Prompt sections the translation child does not get.
 *
 * 翻译摘要是纯文本工作：部署身份、人格（说的是编码 agent）与工具失败反思都与
 * 它无关，而这三段恰恰是提示词里最长的部分。保留 `tool:write` 那一段就够——
 * 它跟着 `write` 工具自己出现，不需要在这里点名。
 */
const DEFAULT_CHILD_OMIT_SECTIONS = ['harness:identity', 'deployment:persona-prefix', 'deployment:error-lessons']

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  archivePath: z.string().min(1).default('.dsh/skill-translations.zh.json'),
  sharedArchivePath: z.string().default('skill-translations.zh.json'),
  targetLocale: z.string().min(1).default('zh'),
  provider: z.string().min(1).default('spawn'),
  childTools: z.array(z.string()).default([...DEFAULT_CHILD_TOOLS]),
  childOmitSections: z.array(z.string()).default([...DEFAULT_CHILD_OMIT_SECTIONS]),
})


/** Resolve and validate configuration; misconfiguration fails at load. */
export function resolveConfig(config: Config): {
  archivePath: string
  sharedArchivePath: string | undefined
  targetLocale: string
  provider: string
  childTools: readonly string[]
  childOmitSections: readonly string[]
} {
  const sharedArchivePath = config.sharedArchivePath ?? 'skill-translations.zh.json'
  return {
    archivePath: config.archivePath ?? '.dsh/skill-translations.zh.json',
    // An explicit empty value is how a deployment opts out of the shared copy.
    sharedArchivePath: sharedArchivePath.trim() === '' ? undefined : sharedArchivePath,
    targetLocale: config.targetLocale ?? 'zh',
    provider: config.provider ?? 'spawn',
    childTools: config.childTools ?? DEFAULT_CHILD_TOOLS,
    childOmitSections: config.childOmitSections ?? DEFAULT_CHILD_OMIT_SECTIONS,
  }
}

/** One catalog entry as the translator sees it: summaries only, never a body. */
export interface SkillSummaryEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

/** Keep only the translatable summary fields of one catalogued skill. */
export function toSummaryEntry(skill: SkillSummary): SkillSummaryEntry {
  return skill.whenToUse === undefined
    ? { name: skill.name, description: skill.description }
    : { name: skill.name, description: skill.description, whenToUse: skill.whenToUse }
}

/** Build the child's prompt: translation instructions plus the summary entries. */
export function buildTranslationPrompt(
  entries: readonly SkillSummaryEntry[],
  archivePath: string,
  targetLocale: string,
  sharedArchivePath?: string,
): ContentBlock[] {
  const listing = entries.map((entry) => {
    const when = entry.whenToUse === undefined ? '' : `\n  whenToUse: ${entry.whenToUse}`
    return `- ${entry.name}\n  description: ${entry.description}${when}`
  }).join('\n')
  const text = [
    'You are translating skill catalog summaries.',
    `Translate the \`description\` and \`whenToUse\` values below into locale \`${targetLocale}\` — natural, concise, technical terms kept recognizable.`,
    'Do NOT translate skill names; do NOT translate anything else; there are no skill bodies in this task.',
    'For every skill also record `promptLine`: the translated catalog line as the system prompt renders it - `- \`name\`: <translated description>` with the UNTRANSLATED name in backticks. Together with the original line, this archives the skill-catalog part of the system prompt in both languages.',
    `Then WRITE the translations as ONE JSON object to ${archivePath}.`,
    ...sharedArchivePath === undefined ? [] : [
      `ALSO write the byte-for-byte same JSON object to ${sharedArchivePath}. Skills live in a user-level registry, so this shared archive is what makes one translation pass cover every workspace — an archive written only into the workspace leaves every other project rendering English. Both files must be identical.`,
    ],
    'The file content is exactly this shape, with every skill name as a key:',
    '{ "skill-name": { "description": "<translated>", "whenToUse": "<translated or omitted>", "promptLine": "- \`skill-name\`: <translated description>" } }',
    'Valid JSON, UTF-8, no comments, no extra keys. Create parent directories via the write tool.',
    'Finish by replying with the count of translated skills.',
    '',
    'Entries:',
    listing,
  ].join('\n')
  return [{ type: 'text', text }]
}

/** Register the command when the command registry is composed. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register({
      name: 'translate-skills',
      description: 'Start a background child that translates every skill summary into the locale archive file.',
      handler: async ({ agent, signal }) => {
        // The preset mounts the filesystem-backed skill registry on the agent
        // scope; the app-level registry has no provider and lists nothing.
        const presets = ctx.get('agentPresets')
        const skills = presets?.serviceFor(agent, 'skills') ?? ctx.get('skills')
        if (skills === undefined) {
          return { kind: 'error', text: 'translate-skills requires the skill registry; mount @deepseek-ai/dsh-skill' }
        }
        const subagents = ctx.get('subagents')
        if (subagents === undefined) {
          return { kind: 'error', text: 'translate-skills requires a subagent runtime; mount @deepseek-ai/dsh-subagent with a provider backend' }
        }
        const cwd = agent.session.header.cwd
        if (cwd === undefined) {
          return { kind: 'error', text: 'translate-skills requires a session with a working directory' }
        }
        // Omitted scope reads the global layer alone; the preset-mounted
        // filesystem provider lives on the agent's scope layer.
        const listed = await skills.list({ cwd, scope: agent })
        const entries = listed.map(toSummaryEntry)
        if (entries.length === 0) {
          return { kind: 'success', text: `No skills catalogued for ${cwd}; nothing to translate.` }
        }
        const archivePath = isAbsolute(resolved.archivePath)
          ? resolved.archivePath
          : join(cwd, resolved.archivePath)
        // The child writes the shared archive by ABSOLUTE path: the harness home
        // is rarely inside the workspace, so a relative one would land elsewhere.
        const sharedArchivePath = resolved.sharedArchivePath === undefined
          ? undefined
          : isAbsolute(resolved.sharedArchivePath)
            ? resolved.sharedArchivePath
            : join(resolveDshHome(), resolved.sharedArchivePath)
        try {
          const run = await subagents.start(resolved.provider, {
            label: 'skill-translation',
            prompt: buildTranslationPrompt(entries, resolved.archivePath, resolved.targetLocale, sharedArchivePath),
            parent: agent,
            signal,
            // 空名单不传：字面上它意味着"一个工具都不留"，而那样的子 agent 连
            // 存档都写不出去。把空数组读作"别动它的工具集"，误配才会落到可用的一侧。
            ...resolved.childTools.length > 0 ? { allowTools: resolved.childTools } : {},
            ...resolved.childOmitSections.length > 0 ? { omitSections: resolved.childOmitSections } : {},
          })
          const sharedNotice = sharedArchivePath === undefined
            ? ''
            : ` and the shared archive ${sharedArchivePath}`
          return {
            kind: 'success',
            text: `Translation child ${String(run.id)} started in the background; it will write ${archivePath}${sharedNotice} (${entries.length} skills, ${resolved.targetLocale}). Track it on the subagent surface.`,
          }
        } catch (error) {
          return { kind: 'error', text: `translate-skills could not start the translation child: ${String(error)}` }
        }
      },
    })
  })
}
