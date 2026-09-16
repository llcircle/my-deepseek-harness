/**
 * 技能目录简介的本地化归档。
 *
 * 这是**用户级资产的用户级缓存**：技能本体住在用户级注册表
 * （`~/.claude/skills` 一类的跨项目目录），归档若只落在工作区，同一个技能换个
 * 项目就退回英文简介——这正是"重新翻一次"反复发生的根因。读取因此分两层：
 * 工作区档优先（项目可以钉自己的措辞），harness home 档补缺，一次翻译覆盖所有
 * 工作区。
 *
 * 本模块只处理"技能名 → 简介译文"，从不读取技能正文。
 *
 * @module @deepseek-ai/dsh-skill/translations
 */

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 默认归档的相对路径：工作区里的 `.dsh/skill-translations.zh.json`。 */
export const DEFAULT_SKILL_TRANSLATION_FILE = '.dsh/skill-translations.zh.json'

/**
 * 归档名候选，优先级高到低。`zh` 档是现行格式；无语言限定的
 * `skill-translations.json` 是更早的写法，保留读取兼容，使老工作区不至于因
 * 改格式而重新显示英文。
 */
export const SKILL_TRANSLATION_FILES = [
  DEFAULT_SKILL_TRANSLATION_FILE,
  '.dsh/skill-translations.json',
] as const

/** 一条技能简介的译文；未提供的字段保留原文。 */
export interface SkillSummaryTranslation {
  readonly description?: string
  readonly whenToUse?: string
}

/**
 * 归档候选的绝对路径，优先级高到低：每个档名先取工作区档，再取同名共享档。
 *
 * @param cwd - 相对档名解析所依据的会话工作区。
 * @param configured - 一个档名，或按优先级排列的档名列表。
 * @param home - 已解析的 harness home；可注入，分层因此可单测。
 * @returns 要按优先级合并的归档路径。
 */
export function skillTranslationFiles(
  cwd: string,
  configured: string | readonly string[],
  home: string = resolveDshHome(),
): string[] {
  const files: string[] = []
  for (const name of typeof configured === 'string' ? [configured] : configured) {
    const workspace = isAbsolute(name) ? name : join(cwd, name)
    const shared = join(home, basename(name))
    files.push(workspace)
    // 绝对配置可以直接指向共享档；此时不要重复读同一个文件。
    if (shared !== workspace) files.push(shared)
  }
  return files
}

/** 认下一个条目字段：只接受非空字符串，其余读作"没有这条译文"。 */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 读一个归档。归档是可选增强：文件缺失、JSON 损坏或形状不符都降级为空，绝不
 * 让目录本身失败——技能列表在任何情况下都必须可用。
 * @param file - 要读取的归档绝对路径。
 * @returns 该文件的条目，缺失或不可用时为空。
 */
async function readOneSkillTranslations(file: string): Promise<Map<string, SkillSummaryTranslation>> {
  const translations = new Map<string, SkillSummaryTranslation>()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return translations
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return translations
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return translations
  for (const [name, value] of Object.entries(parsed)) {
    // 字符串值是更早的格式：整条内容就是简介正文。
    const bare = stringField(value)
    if (bare !== undefined) {
      translations.set(name, { description: bare })
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as { description?: unknown; whenToUse?: unknown }
    const description = stringField(entry.description)
    const whenToUse = stringField(entry.whenToUse)
    if (description !== undefined || whenToUse !== undefined) {
      translations.set(name, {
        ...description === undefined ? {} : { description },
        ...whenToUse === undefined ? {} : { whenToUse },
      })
    }
  }
  return translations
}

/**
 * 按优先级合并读取归档。
 *
 * 合并是**逐字段**的：某个档只译了 `description` 时，另一个档的 `whenToUse`
 * 仍然生效。整条替换会让"补一条译文"变成"删掉另一条"，而这两个字段由不同的
 * 翻译轮次写入，逐字段合并是唯一不会互相抹掉的语义。
 *
 * @param cwd - 相对档名解析所依据的会话工作区。
 * @param configured - 一个档名，或按优先级排列的档名列表。
 * @param home - 已解析的 harness home；可注入，分层因此可单测。
 * @returns 合并后的译文，无归档时为空。
 */
export async function readSkillTranslations(
  cwd: string,
  configured: string | readonly string[],
  home: string = resolveDshHome(),
): Promise<Map<string, SkillSummaryTranslation>> {
  const merged = new Map<string, SkillSummaryTranslation>()
  // 反转后由低优先级读到高优先级，后写的覆盖先写的。
  for (const file of skillTranslationFiles(cwd, configured, home).reverse()) {
    for (const [name, translation] of await readOneSkillTranslations(file)) {
      merged.set(name, { ...merged.get(name), ...translation })
    }
  }
  return merged
}
