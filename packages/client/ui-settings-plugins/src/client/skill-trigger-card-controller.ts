/**
 * The skill-trigger card's staged rows over the `skill-filesystem` settings
 * namespace. Rows are seeded from the session's live skill catalog and the
 * selected scope's committed overrides, then staged locally and written as one
 * dict on save.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CardShell } from './card-form.ts'

/**
 * Namespace of the local filesystem skill provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const SKILL_FILESYSTEM_NS = 'skill-filesystem'

/** Valid skill-name grammar; the Host owns the same rule and rejects otherwise. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The trigger states a row can hold, matching the Host schema's union. */
export const SKILL_TRIGGER_STATES = ['passive', 'active-only', 'ignored'] as const

/** One trigger state value. */
export type SkillTriggerStateValue = (typeof SKILL_TRIGGER_STATES)[number]

/** Scope whose override map the card edits. */
export type SkillTriggerScope = 'global' | 'project'

/** Workspace-scoped trigger-state settings. */
export interface SkillTriggerProjectSettings {
  /** Per-skill trigger states overriding the global section. */
  invocationOverrides?: Record<string, SkillTriggerStateValue>
}

/** The section this card edits. */
export interface SkillTriggerSettings {
  /** Global per-skill trigger states overriding skill frontmatter. */
  invocationOverrides?: Record<string, SkillTriggerStateValue>
  /** Workspace-scoped trigger states; the session cwd is the key. */
  projects?: Record<string, SkillTriggerProjectSettings>
}

/** One skill discovered from the live session catalog. */
export interface SkillTriggerCatalogEntry {
  /** Kebab-case skill name. */
  readonly name: string
  /** Whether the model can invoke the skill without an explicit user gesture. */
  readonly modelInvocable: boolean
}

/** Runtime dependencies for automatic skill discovery and project selection. */
export interface SkillTriggerCardDeps {
  /** Load the current session's visible skill catalog. */
  loadSkills: (sessionId: SessionId) => Promise<readonly SkillTriggerCatalogEntry[]>
  /** Resolve the current session's workspace path. */
  workspace: () => string | undefined
  /** Resolve the current session id. */
  sessionId: () => SessionId | undefined
}

/** One staged or committed override row as the card renders it. */
export interface SkillTriggerRowState {
  /** Skill name the row overrides; empty means a new, unnamed row. */
  name: string
  /** Selected trigger state. */
  state: SkillTriggerStateValue
  /** Whether the name is not a valid unique skill name, which blocks saving. */
  invalid: boolean
}

/** What the skill-trigger card renders. */
export interface SkillTriggerCardState extends CardShell {
  /** The staged rows when edits exist, otherwise the committed rows. */
  rows: readonly SkillTriggerRowState[]
  /** Scope whose override map is rendered and saved. */
  scope: SkillTriggerScope
  /** Current workspace path, when a session is selected. */
  workspace: string | undefined
  /** Live skill discovery state. */
  skillsStatus: 'idle' | 'loading' | 'error'
  /** Discovery failure text, when the catalog request failed. */
  skillsError: string | undefined
}

/** The registration-side face the skill-trigger card's slot entry injects. */
export interface SkillTriggerCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSkillTriggerCard. */
    skillTriggerCard: SnapshotStore<SkillTriggerCardState>
  }
  /** Append one unnamed row at the default state. */
  addRow(): void
  /** Drop the row at an index. */
  removeRow(index: number): void
  /** Stage a row's skill name. */
  editRowName(index: number, name: string): void
  /** Stage a row's trigger state. */
  editRowState(index: number, state: string): void
  /** Select the global or current-workspace override map. */
  setScope(scope: SkillTriggerScope): void
  /** Re-read the current session's skill catalog after a session switch. */
  refresh(): void
  /** Write every staged row as one dict write, then re-seed from the Host. */
  save(): void
  /** Drop every staged row. */
  discard(): void
}

interface Row {
  name: string
  state: SkillTriggerStateValue
}

/** Bridges the `skill-filesystem` scope onto the staged rows. */
export class SkillTriggerCardController {
  private readonly store: SnapshotStore<SkillTriggerCardState>
  private staged: Row[] | undefined
  private saving = false
  private failed = false
  private selectedScope: SkillTriggerScope = 'global'
  private skills: readonly SkillTriggerCatalogEntry[] = []
  private skillsStatus: 'idle' | 'loading' | 'error' = 'idle'
  private skillsError: string | undefined
  private loadedSessionId: SessionId | undefined
  private readonly deps: SkillTriggerCardDeps | undefined

  /**
   * @param scope - the bound settings scope for the `skill-filesystem` namespace.
   * @param deps - optional live catalog and session dependencies.
   */
  constructor(
    private readonly scope: SettingsScope<SkillTriggerSettings>,
    deps?: SkillTriggerCardDeps,
  ) {
    this.deps = deps
    if (deps?.workspace() !== undefined) this.selectedScope = 'project'
    this.store = createSnapshotStore(this.projection())
    this.scope.subscribe(() => { this.publish() })
    if (deps !== undefined) void this.refreshSkills()
  }

  private committedRows(): Row[] {
    const settings = this.scope.getSnapshot().value ?? {}
    const workspace = this.workspace()
    const overrides = this.selectedScope === 'global'
      ? settings.invocationOverrides ?? {}
      : workspace === undefined ? {} : settings.projects?.[workspace]?.invocationOverrides ?? {}
    const names = new Set<string>([
      ...this.skills.map(skill => skill.name),
      ...Object.keys(overrides),
    ])
    return [...names].sort().flatMap((name) => {
      const state = overrides[name]
      if (state !== undefined) return [{ name, state }]
      const discovered = this.skills.find(skill => skill.name === name)
      return [{ name, state: discovered?.modelInvocable === false ? 'active-only' : 'passive' }]
    })
  }

  private workspace(): string | undefined {
    return this.deps?.workspace()
  }

  private rows(): Row[] {
    return this.staged ?? this.committedRows()
  }

  private projection(): SkillTriggerCardState {
    const snapshot = this.scope.getSnapshot()
    const rows = this.rows()
    const seen = new Set<string>()
    const rendered = rows.map((row) => {
      const name = row.name.trim()
      const duplicate = name !== '' && seen.has(name)
      seen.add(name)
      return {
        name: row.name,
        state: row.state,
        invalid: name !== '' && (!SKILL_NAME.test(name) || duplicate),
      }
    })
    return {
      available: snapshot.status !== 'unavailable',
      writable: snapshot.writable,
      dirty: this.staged !== undefined,
      invalid: rendered.some(row => row.invalid),
      saving: this.saving,
      failed: this.failed,
      rows: rendered,
      scope: this.selectedScope,
      workspace: this.workspace(),
      skillsStatus: this.skillsStatus,
      skillsError: this.skillsError,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private ensureStaged(): Row[] {
    this.staged ??= this.committedRows().map(row => ({ ...row }))
    return this.staged
  }

  private withStaged(edit: (rows: Row[]) => void): void {
    edit(this.ensureStaged())
    this.failed = false
    this.publish()
  }

  private async refreshSkills(force = false): Promise<void> {
    if (this.deps === undefined) return
    const sessionId = this.deps.sessionId()
    if (sessionId === undefined || (!force && sessionId === this.loadedSessionId)) return
    this.loadedSessionId = sessionId
    if (this.workspace() !== undefined && this.staged === undefined) this.selectedScope = 'project'
    this.skillsStatus = 'loading'
    this.skillsError = undefined
    this.publish()
    try {
      this.skills = await this.deps.loadSkills(sessionId)
      this.skillsStatus = 'idle'
      this.publish()
    } catch (error: unknown) {
      this.skills = []
      this.skillsStatus = 'error'
      this.skillsError = error instanceof Error ? error.message : String(error)
      this.publish()
    }
  }

  /** Re-read the current session's skill catalog after a session switch. */
  refresh(): void {
    void this.refreshSkills()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its row actions.
   */
  inject(): SkillTriggerCardFace {
    return {
      hooks: { skillTriggerCard: this.store },
      addRow: () => { this.withStaged((rows) => { rows.push({ name: '', state: 'passive' }) }) },
      removeRow: (index) => { this.withStaged((rows) => { rows.splice(index, 1) }) },
      editRowName: (index, name) => { this.withStaged((rows) => { const row = rows[index]; if (row) row.name = name }) },
      editRowState: (index, state) => {
        // The select offers only the schema's values; an unknown one must not
        // stage, or the save would fail the Host schema the user cannot see.
        if (!SKILL_TRIGGER_STATES.includes(state as SkillTriggerStateValue)) return
        this.withStaged((rows) => { const row = rows[index]; if (row) row.state = state as SkillTriggerStateValue })
      },
      setScope: (scope) => {
        if (scope === this.selectedScope) return
        if (scope === 'project' && this.workspace() === undefined) return
        this.selectedScope = scope
        this.staged = undefined
        this.failed = false
        this.publish()
      },
      refresh: () => { void this.refreshSkills(true) },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged === undefined && !this.failed) return
        this.staged = undefined
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged row as one dict write, then re-seed from what the Host
   * accepted. Unnamed rows save as nothing; the Host is the only authority on
   * whether the write landed, so the outcome is read back from the user layer.
   */
  async save(): Promise<void> {
    const state = this.projection()
    if (!state.dirty || state.invalid || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    const record: Record<string, SkillTriggerStateValue> = {}
    for (const row of this.rows()) {
      const name = row.name.trim()
      if (name !== '') record[name] = row.state
    }
    if (this.selectedScope === 'global') {
      await this.scope.set('invocationOverrides', record)
    } else {
      const workspace = this.workspace()
      if (workspace !== undefined) {
        const settings = this.scope.getSnapshot().value ?? {}
        const projects = { ...(settings.projects ?? {}) }
        projects[workspace] = { invocationOverrides: record }
        await this.scope.set('projects', projects)
      }
    }
    const user = this.scope.getSnapshot().user as SkillTriggerSettings | undefined
    const workspace = this.workspace()
    const landed = this.selectedScope === 'global'
      ? JSON.stringify(user?.invocationOverrides) === JSON.stringify(record)
      : workspace !== undefined
        && JSON.stringify(user?.projects?.[workspace]?.invocationOverrides) === JSON.stringify(record)
    this.saving = false
    if (landed) this.staged = undefined
    this.failed = !landed
    this.publish()
  }
}
