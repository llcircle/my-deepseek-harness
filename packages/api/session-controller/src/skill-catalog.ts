<<<<<<< ours
=======
<<<<<<< ours
>>>>>>> theirs
/** Session-addressed, cold-readable skill catalog Remote. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import {
  readSkillTranslations,
  SKILL_TRANSLATION_FILES,
  type SkillSummaryTranslation,
} from '@deepseek-ai/dsh-skill/translations'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillEntry, SkillListRequest, SkillListValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    void signal
    const { sessionId } = request
    let cwd: string | undefined
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.header.cwd
      agentPreset = observation.projections.values.agentPreset ?? undefined
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }
    if (cwd === undefined) {
      throw new RemoteError('gateway/internal', `session "${sessionId}" has no project cwd`, {})
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    const scope = await this.scopeFor(sessionId, agentPreset)
    try {
      const hostRegistry = this.ctx.get('skills')
      const registries = hostRegistry !== undefined && hostRegistry !== skillRegistry
        ? [skillRegistry, hostRegistry]
        : [skillRegistry]
      const byName = new Map<string, Awaited<ReturnType<typeof skillRegistry.list>>[number]>()
      for (const registry of registries) {
        for (const skill of await registry.list({ cwd, scope })) {
          if (!byName.has(skill.name)) byName.set(skill.name, skill)
        }
      }
      const skills = [...byName.values()].filter(isUserInvocable)
      // 简介译文归档按工作区 → harness home 分层（见 dsh-skill/translations）。
      // 技能取自**用户级**注册表，只读工作区档会让新项目里的每一个技能都退回
      // 英文简介——而斜杠菜单正是用户看到简介的地方。
      const translations = isChineseLocale(request.locale) || request.locale === undefined
        ? await readSkillTranslations(cwd, SKILL_TRANSLATION_FILES)
        : new Map<string, SkillSummaryTranslation>()
      return {
        skills: skills.map(skill => localizedSkillEntry({
          name: skill.name,
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        }, translations)),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    sessionId: SessionId,
    agentPreset: string | undefined,
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.standingKeyFor(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }
}

export default SessionSkillCatalog

/** 判断界面语言是否要求使用中文技能简介归档。 */
function isChineseLocale(locale: string | undefined): boolean {
  return locale === 'zh' || locale?.startsWith('zh-') === true
}

/** 将归档中的中文简介应用到斜杠菜单条目，不触碰技能正文。 */
function localizedSkillEntry(
  skill: SkillEntry,
  translations: ReadonlyMap<string, SkillSummaryTranslation>,
): SkillEntry {
  const translation = translations.get(skill.name)
  if (translation === undefined) return skill
  return {
    ...skill,
    ...(translation.description === undefined ? {} : { description: translation.description }),
    ...(translation.whenToUse === undefined ? {} : { whenToUse: translation.whenToUse }),
  }
}
<<<<<<< ours
=======
=======
/** Session-addressed, cold-readable skill catalog Remote. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillListRequest, SkillListValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    void signal
    const { sessionId } = request
    let cwd: string | undefined
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.header.cwd
      agentPreset = observation.projections.values.agentPreset ?? undefined
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }
    if (cwd === undefined) {
      throw new RemoteError('gateway/internal', `session "${sessionId}" has no project cwd`, {})
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    const scope = await this.scopeFor(sessionId, agentPreset)
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    sessionId: SessionId,
    agentPreset: string | undefined,
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.standingKeyFor(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }
}

export default SessionSkillCatalog
>>>>>>> theirs
>>>>>>> theirs
