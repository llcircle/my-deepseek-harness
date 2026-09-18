/** Staged editing for system-prompt section replacements and per-ability lessons. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Client mirror of the Host prompt-overrides settings namespace. */
export const SYSTEM_PROMPT_OVERRIDES_NS = 'system-prompt-overrides'

/**
 * UI prompt language.
 *
 * 这里不再有"当前语言"开关：装配语言来自界面语言设置，编辑界面只是同时提供
 * 中英两栏文本，让用户一次把两种语言都写好。谁生效由设置决定，不由这张卡片决定。
 */
export type PromptLocale = 'zh' | 'en'

/** One language-separated replacement. */
export interface PromptLocaleOverride {
  zh?: string
  en?: string
}

/** The section this card edits. */
export interface PromptOverridesSettings {
  sectionCatalog?: readonly string[]
  sections?: Record<string, PromptLocaleOverride>
}

/** One prompt section current-text preview returned by the Host. */
export interface PromptSectionPreview {
  name: string
  en: string
  zh: string
  editable: boolean
}

/** One journaled tool or MCP failure. */
export interface ToolErrorPreview {
  time: string
  sessionId: string
  seq: number
  name: string
  callId: string
  text: string
}

/** One subject's lessons, as stored in the reflection document. */
export interface ReflectionBlockPreview {
  subject: string
  text: string
}

/** 一条能力（工具 / MCP 服务器 / 电脑操作）在卡片上的一行。 */
export interface ReflectionRow {
  /** 提示词分段名，也是 LESSONS 文档里的主题键。 */
  readonly subject: string
  /** 能力类别，决定这一行怎么称呼自己。 */
  readonly kind: 'tool' | 'mcp' | 'computer'
  /** 能力名字（`tool:read` → `read`；`computer:policy` 没有名字）。 */
  readonly label: string
  /** 当前教训文本（含未保存的编辑）。 */
  readonly text: string
  /** 这一节当前的介绍文本，供用户对照；没有介绍时为空串。 */
  readonly zh: string
  readonly en: string
}

/** What the last correction attempt reported. */
export type ToolErrorCorrectionState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  /** `message` is the command's own receipt; absent when it reported no text. */
  | { readonly phase: 'done'; readonly message: string | undefined }
  /** No session is open, so there is nowhere to run the correction command. */
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'failed'; readonly error: string }

/** Runtime dependencies for loading the live prompt-section catalog and failure documents. */
export interface PromptOverridesCardDeps {
  /** Session workspace the Chinese preview column is read from; `undefined` leaves it empty. */
  workspace(): string | undefined
  /** Read the Host's current prompt-section previews. */
  readPromptSections(workspace?: string): Promise<readonly PromptSectionPreview[]>
  /** Read the journaled tool and MCP failures. */
  readToolErrors(): Promise<readonly ToolErrorPreview[]>
  /** Read the subject-sectioned lessons of the reflection document. */
  readReflections(): Promise<readonly ReflectionBlockPreview[]>
  /**
   * Write the given subjects' lessons; every other part of the document — including
   * subjects this deployment does not compose — is left alone by the Host.
   */
  writeReflections(blocks: readonly ReflectionBlockPreview[]): Promise<void>
  /** Whether a session is open to run the correction command in. */
  canRunCorrection(): boolean
  /**
   * Run the deployment's `/correct-errors` pass in the open session, returning
   * the command's own receipt text for the card to show.
   *
   * 这里刻意不自己融合日志与经验：那套流水线已经存在
   * （`@deepseek-ai/dsh-command-correct-errors`：融合 → 写反思文档 → 把日志原文
   * 追加进归档 → 清空日志），再写一遍就会有两个入口维护同一份文档。
   */
  runCorrection(): Promise<string | undefined>
}

/** What the prompt-overrides card renders. */
export interface PromptOverridesCardState extends CardShell {
  sectionNames: readonly string[]
  selectedSection: string
  currentZh: string
  currentEn: string
  sectionsStatus: 'idle' | 'loading' | 'ready' | 'error'
  sectionsError: string | undefined
  toolErrors: readonly ToolErrorPreview[]
  toolErrorsStatus: 'idle' | 'loading' | 'ready' | 'error'
  toolErrorsError: string | undefined
  /** 每条已装配能力一行：介绍在左、教训在右，未装配的能力根本不在表里。 */
  reflectionRows: readonly ReflectionRow[]
  /** 文档里还留着、但这次装配里没有对应能力的主题条数。 */
  staleReflections: number
  reflectionsStatus: 'idle' | 'loading' | 'ready' | 'error'
  reflectionsError: string | undefined
  reflectionsDirty: boolean
  reflectionsSaving: boolean
  reflectionsFailed: boolean
  correction: ToolErrorCorrectionState
  selectedZh: string
  selectedEn: string
}

/** The registration-side face the card's slot entry injects. */
export interface PromptOverridesCardFace {
  hooks: {
    promptOverridesCard: SnapshotStore<PromptOverridesCardState>
  }
  selectSection(name: string): void
  /**
   * Re-read every document this card shows.
   *
   * 刻意不接收参数：它的工作区来自装配时注入的读取器，而不是调用点。曾经的
   * `onClick={refresh}` 会把 React 的点击事件当成工作区路径传下去，被 Host 的
   * 参数校验原样拒绝——把参数从这个签名里去掉，这类调用就再也没有出错的机会。
   */
  refresh(): void
  editSection(locale: PromptLocale, text: string): void
  addSection(name: string): void
  removeSection(name: string): void
  editReflection(subject: string, text: string): void
  saveReflections(): void
  discardReflections(): void
  runCorrection(): void
  save(): void
  discard(): void
}

interface StagedState {
  sectionNames: string[]
  sections: Record<string, PromptLocaleOverride>
}

/** 卡片认得的"能力分段"：工具、MCP 服务器，以及电脑操作。 */
const TOOL_PREFIX = 'tool:'
const MCP_PREFIX = 'mcp:'
const COMPUTER_SECTION = 'computer:policy'

/**
 * 判断一个分段名是不是"能力"。
 *
 * 判定发生在分段名上，而"有哪些能力"这件事必须来自**这次装配的注册结果**：
 * `mcp:<serverName>` 的名字取决于运行期挂了哪些服务器，`computer:policy`
 * 只在启用电脑操作的会话里才注册。用户想看的是"这个会话里到底有什么"，
 * 不是"代码库里可能有什么"——所以名字匹配只是分类，是否存在由调用方保证。
 *
 * @param name - 分段名。
 * @returns 能力类别；不是能力分段时返回 `undefined`。
 */
export function reflectionKindOf(name: string): ReflectionRow['kind'] | undefined {
  if (name === COMPUTER_SECTION) return 'computer'
  if (name.startsWith(TOOL_PREFIX) && name.length > TOOL_PREFIX.length) return 'tool'
  if (name.startsWith(MCP_PREFIX) && name.length > MCP_PREFIX.length) return 'mcp'
  return undefined
}

/** 能力名字：去掉类别前缀，电脑操作没有名字。 */
function labelOf(name: string, kind: ReflectionRow['kind']): string {
  if (kind === 'tool') return name.slice(TOOL_PREFIX.length)
  if (kind === 'mcp') return name.slice(MCP_PREFIX.length)
  return ''
}

/** Bridges the `system-prompt-overrides` scope onto staged edits. */
export class PromptOverridesCardController {
  private readonly store: SnapshotStore<PromptOverridesCardState>
  private staged: StagedState | undefined
  private saving = false
  private failed = false
  private selectedSection: string
  private sections = new Map<string, { zh: string; en: string }>()
  /** 全部已注册分段的预览，含不可编辑的那些——能力清单要从这里取介绍文本。 */
  private liveSections = new Map<string, PromptSectionPreview>()
  private sectionsStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  private sectionsError: string | undefined
  private toolErrors: ToolErrorPreview[] = []
  private toolErrorsStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  private toolErrorsError: string | undefined
  /** 文档里各个主题的教训，按刷新时刻的原样。 */
  private committedReflections = new Map<string, string>()
  /** 未保存的改动，键是主题；只记录真正改过的那些。 */
  private stagedReflections: Map<string, string> | undefined
  private reflectionsStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  private reflectionsError: string | undefined
  private savingReflections = false
  private failedReflections = false
  private correction: ToolErrorCorrectionState = { phase: 'idle' }
  private readonly deps: PromptOverridesCardDeps | undefined

  constructor(
    private readonly scope: SettingsScope<PromptOverridesSettings>,
    deps?: PromptOverridesCardDeps,
  ) {
    this.deps = deps
    const names = this.committedNames()
    this.selectedSection = names[0] ?? ''
    this.store = createSnapshotStore(this.projection())
    this.scope.subscribe(() => { this.publish() })
  }

  private committedNames(): string[] {
    const value = this.scope.getSnapshot().value ?? {}
    return [...new Set([
      ...(value.sectionCatalog ?? []),
      ...Object.keys(value.sections ?? {}),
    ])].sort((a, b) => a.localeCompare(b))
  }

  private fetchedNames(): string[] {
    return [...this.sections.keys()].sort((a, b) => a.localeCompare(b))
  }

  private availableNames(): string[] {
    const fetched = this.fetchedNames()
    return fetched.length > 0 ? fetched : this.committedNames()
  }

  private stagedOrDefault(): StagedState {
    if (this.staged !== undefined) return this.staged
    const value = this.scope.getSnapshot().value ?? {}
    return {
      sectionNames: [...this.availableNames()],
      sections: Object.fromEntries(
        Object.entries(value.sections ?? {}).map(([name, override]) => [name, { ...override }]),
      ),
    }
  }

  private sectionOverride(name: string): PromptLocaleOverride {
    return this.stagedOrDefault().sections[name] ?? {}
  }

  private sectionCurrent(name: string): PromptLocaleOverride {
    return this.sections.get(name) ?? {}
  }

  /**
   * 这次装配里真实存在的能力：都从分段预览里现取，没有编好的名单。
   * @returns 按类别与名字排好序的主题键。
   */
  private liveSubjects(): string[] {
    return [...this.liveSections.keys()]
      .filter(name => reflectionKindOf(name) !== undefined)
      .sort((a, b) => a.localeCompare(b))
  }

  /** 一行能力的当前教训：未保存的改动优先。 */
  private reflectionText(subject: string): string {
    return this.stagedReflections?.get(subject)
      ?? this.committedReflections.get(subject)
      ?? ''
  }

  /** 文档里有教训、但这次装配里没有对应能力——它们不会被注入提示词。 */
  private staleReflectionCount(): number {
    const live = new Set(this.liveSubjects())
    return [...this.committedReflections.keys()].filter(subject => !live.has(subject)).length
  }

  private reflectionRows(): ReflectionRow[] {
    return this.liveSubjects().flatMap((subject) => {
      const kind = reflectionKindOf(subject)
      /* v8 ignore next -- liveSubjects() 已经过滤过，这里只是把类型收窄。 */
      if (kind === undefined) return []
      const preview = this.liveSections.get(subject)
      return [{
        subject,
        kind,
        label: labelOf(subject, kind),
        text: this.reflectionText(subject),
        // 不可编辑的分段（电脑操作）不预填介绍：装配时它只有启用会话才有注册，
        // 这张卡片问不了某个会话，于是诚实地空着。
        zh: preview?.zh ?? '',
        en: preview?.en ?? '',
      }]
    })
  }

  private projection(): PromptOverridesCardState {
    const snapshot = this.scope.getSnapshot()
    const state = this.stagedOrDefault()
    const override = this.sectionOverride(this.selectedSection)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged !== undefined,
      invalid: false,
      saving: this.saving,
      failed: this.failed,
      sectionNames: state.sectionNames,
      selectedSection: this.selectedSection,
      currentZh: this.sectionCurrent(this.selectedSection).zh ?? '',
      currentEn: this.sectionCurrent(this.selectedSection).en ?? '',
      sectionsStatus: this.sectionsStatus,
      sectionsError: this.sectionsError,
      toolErrors: this.toolErrors,
      toolErrorsStatus: this.toolErrorsStatus,
      toolErrorsError: this.toolErrorsError,
      reflectionRows: this.reflectionRows(),
      staleReflections: this.staleReflectionCount(),
      reflectionsStatus: this.reflectionsStatus,
      reflectionsError: this.reflectionsError,
      reflectionsDirty: this.stagedReflections !== undefined,
      reflectionsSaving: this.savingReflections,
      reflectionsFailed: this.failedReflections,
      correction: this.correction,
      selectedZh: override.zh ?? this.sectionCurrent(this.selectedSection).zh ?? '',
      selectedEn: override.en ?? this.sectionCurrent(this.selectedSection).en ?? '',
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private stage(edit: (state: StagedState) => void): void {
    const state = this.staged ?? this.stagedOrDefault()
    this.staged = state
    edit(state)
    this.failed = false
    this.publish()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns The store plus the select, refresh, and edit callbacks the card slot consumes.
   */
  inject(): PromptOverridesCardFace {
    return {
      hooks: { promptOverridesCard: this.store },
      selectSection: (name) => {
        if (!this.availableNames().includes(name)) return
        this.selectedSection = name
        this.publish()
      },
      refresh: () => { void this.refresh() },
      editSection: (locale, text) => {
        if (this.selectedSection === '') return
        this.stage((state) => {
          state.sections[this.selectedSection] = {
            ...state.sections[this.selectedSection],
            [locale]: text,
          }
        })
      },
      addSection: (name) => {
        const trimmed = name.trim()
        if (trimmed === '') return
        this.stage((state) => {
          if (!state.sectionNames.includes(trimmed)) state.sectionNames.push(trimmed)
          state.sections[trimmed] ??= {}
        })
        this.selectedSection = trimmed
        this.publish()
      },
      removeSection: (name) => {
        this.stage((state) => {
          state.sectionNames = state.sectionNames.filter(candidate => candidate !== name)
          state.sections = Object.fromEntries(
            Object.entries(state.sections).filter(([key]) => key !== name),
          )
          if (this.selectedSection === name) this.selectedSection = state.sectionNames[0] ?? ''
        })
      },
      editReflection: (subject, text) => {
        const next = new Map(this.stagedReflections ?? [])
        // 改回原样就不算改动：否则"点开又点掉"会留下一次没有内容的保存。
        if (text === (this.committedReflections.get(subject) ?? '')) next.delete(subject)
        else next.set(subject, text)
        this.stagedReflections = next.size === 0 ? undefined : next
        this.failedReflections = false
        this.publish()
      },
      saveReflections: () => { void this.saveReflections() },
      discardReflections: () => {
        if (this.stagedReflections === undefined && !this.failedReflections) return
        this.stagedReflections = undefined
        this.failedReflections = false
        this.publish()
      },
      runCorrection: () => { void this.runCorrection() },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged === undefined && !this.failed) return
        this.staged = undefined
        this.failed = false
        this.publish()
      },
    }
  }

  /** Re-read the Host's current prompt sections, failures, and per-ability lessons. */
  async refresh(): Promise<void> {
    if (this.deps === undefined || this.sectionsStatus === 'loading') return
    this.sectionsStatus = 'loading'
    this.sectionsError = undefined
    this.toolErrorsStatus = 'loading'
    this.toolErrorsError = undefined
    this.reflectionsStatus = 'loading'
    this.reflectionsError = undefined
    this.correction = { phase: 'idle' }
    this.publish()
    try {
      const rows = await this.deps.readPromptSections(this.deps.workspace())
      this.liveSections = new Map(rows.map(row => [row.name, row]))
      this.sections = new Map(rows.filter(row => row.editable).map(row => [row.name, { zh: row.zh, en: row.en }]))
      this.sectionsStatus = 'ready'
      const names = this.availableNames()
      if (!names.includes(this.selectedSection)) this.selectedSection = names[0] ?? ''
      const [toolErrors, reflections] = await Promise.all([
        this.deps.readToolErrors(),
        this.deps.readReflections(),
      ])
      this.toolErrors = [...toolErrors]
      this.toolErrorsStatus = 'ready'
      this.committedReflections = new Map(reflections.map(block => [block.subject, block.text]))
      this.stagedReflections = undefined
      this.failedReflections = false
      this.reflectionsStatus = 'ready'
      this.publish()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.sectionsStatus = 'error'
      this.sectionsError = message
      this.toolErrorsStatus = 'error'
      this.toolErrorsError = message
      this.reflectionsStatus = 'error'
      this.reflectionsError = message
      this.publish()
    }
  }

  /** Write all staged section edits as one settings replacement. */
  async save(): Promise<void> {
    const state = this.projection()
    if (!state.dirty || state.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const staged = this.staged
      if (staged === undefined) return
      await this.scope.mutate([
        { op: 'set', path: ['sectionCatalog'], value: staged.sectionNames as never },
        { op: 'set', path: ['sections'], value: staged.sections as never },
      ])
      this.staged = undefined
      const names = this.committedNames()
      if (!names.includes(this.selectedSection)) this.selectedSection = names[0] ?? ''
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /**
   * 写回改动过的主题教训。
   *
   * 只送**真正改过**的主题：文档里还有这次装配没有的能力留下的经验，界面从来没
   * 显示过它们，把整份文档倒回去就等于替用户删掉自己没看见的东西。
   */
  async saveReflections(): Promise<void> {
    const staged = this.stagedReflections
    if (this.deps === undefined || staged === undefined || this.savingReflections) return
    this.savingReflections = true
    this.failedReflections = false
    this.publish()
    try {
      const blocks = [...staged].map(([subject, text]) => ({ subject, text }))
      await this.deps.writeReflections(blocks)
      for (const [subject, text] of staged) {
        if (text === '') this.committedReflections.delete(subject)
        else this.committedReflections.set(subject, text)
      }
      this.stagedReflections = undefined
    } catch {
      this.failedReflections = true
    } finally {
      this.savingReflections = false
      this.publish()
    }
  }

  /**
   * Run the deployment's existing `/correct-errors` pass in the open session.
   *
   * 这个按钮只负责"按下"，融合与归档由已经存在的命令完成——那条路径会把日志
   * 原文先追加进只追加写的归档，再清空日志，所以这里不需要（也不该）动本地状态：
   * 教训文档由后台子代理稍后重写，用户点"刷新"就能看到新的一版。
   */
  async runCorrection(): Promise<void> {
    if (this.deps === undefined || this.correction.phase === 'running') return
    if (!this.deps.canRunCorrection()) {
      this.correction = { phase: 'unavailable' }
      this.publish()
      return
    }
    this.correction = { phase: 'running' }
    this.publish()
    try {
      const message = await this.deps.runCorrection()
      this.correction = { phase: 'done', message }
    } catch (error: unknown) {
      this.correction = {
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.publish()
    }
  }
}
