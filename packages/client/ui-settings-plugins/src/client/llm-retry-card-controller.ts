/**
 * The llm-deepseek retry card's staged form: the model-request retry mode and,
 * in normal mode, the retry count. Saved through one nested path mutation so
 * sibling retry-policy fields (backoff, retryable codes) the card does not
 * show keep their stored values.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Namespace of the DeepSeek adapter. Spelled here: no Host imports client-side. */
export const LLM_DEEPSEEK_NS = 'llm-deepseek'

/** The retry modes the card offers. */
export const RETRY_MODES = ['normal', 'always'] as const

/** One retry mode value. */
export type RetryModeValue = (typeof RETRY_MODES)[number]

/** The section fields this card edits. */
export interface LlmRetrySettings {
  /** Provider retry policy; schema-resolved with defaults when unset. */
  retryPolicy?: {
    readonly mode: 'normal' | 'always'
    readonly maxRetries?: number
  }
}

/** What the retry card renders. */
export interface LlmRetryCardState extends CardShell {
  /** Selected mode. */
  mode: RetryModeValue
  /** Staged or committed retry count (normal mode only). */
  maxRetries: number | undefined
  /** Whether a staged maxRetries is not a non-negative integer, which blocks saving. */
  maxRetriesInvalid: boolean
}

/** The registration-side face the retry card's slot entry injects. */
export interface LlmRetryCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useLlmRetryCard. */
    llmRetryCard: SnapshotStore<LlmRetryCardState>
  }
  /** Stage a retry mode. */
  editMode(mode: string): void
  /** Stage a retry count; empty means the schema default (five). */
  editMaxRetries(text: string): void
  /** Write the staged values in one mutation, then re-seed from the Host. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
}

const DEFAULT_MAX_RETRIES = 5

/** Bridges the `llm-deepseek` scope onto the staged retry values. */
export class LlmRetryCardController {
  private readonly store: SnapshotStore<LlmRetryCardState>
  private stagedMode: RetryModeValue | undefined
  private stagedMaxRetries: number | undefined
  private stagedClearMaxRetries = false
  private saving = false
  private failed = false

  /** @param scope - the bound settings scope for the `llm-deepseek` namespace. */
  constructor(private readonly scope: SettingsScope<LlmRetrySettings>) {
    this.store = createSnapshotStore(this.projection())
    this.scope.subscribe(() => { this.publish() })
  }

  private committed(): { mode: RetryModeValue; maxRetries: number | undefined } {
    const policy = this.scope.getSnapshot().value?.retryPolicy
    const mode: RetryModeValue = policy?.mode === 'always' ? 'always' : 'normal'
    // No stored policy means the schema's own normal default (five retries).
    return { mode, maxRetries: mode === 'normal' ? policy?.maxRetries ?? DEFAULT_MAX_RETRIES : undefined }
  }

  private projection(): LlmRetryCardState {
    const snapshot = this.scope.getSnapshot()
    const committed = this.committed()
    const mode = this.stagedMode ?? committed.mode
    const maxRetries = this.stagedClearMaxRetries
      ? undefined
      : this.stagedMaxRetries ?? committed.maxRetries
    return {
      available: snapshot.status !== 'unavailable',
      writable: snapshot.writable,
      dirty: this.stagedMode !== undefined || this.stagedMaxRetries !== undefined || this.stagedClearMaxRetries,
      invalid: this.stagedMaxRetries !== undefined && (!Number.isInteger(this.stagedMaxRetries) || this.stagedMaxRetries < 0),
      saving: this.saving,
      failed: this.failed,
      mode,
      maxRetries: mode === 'normal' ? maxRetries : undefined,
      maxRetriesInvalid: mode === 'normal' && this.stagedMaxRetries !== undefined
        && (!Number.isInteger(this.stagedMaxRetries) || this.stagedMaxRetries < 0),
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its staged actions.
   */
  inject(): LlmRetryCardFace {
    return {
      hooks: { llmRetryCard: this.store },
      editMode: (mode) => {
        if (!RETRY_MODES.includes(mode as RetryModeValue)) return
        this.stagedMode = mode as RetryModeValue
        this.failed = false
        this.publish()
      },
      editMaxRetries: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') {
          this.stagedMaxRetries = undefined
          this.stagedClearMaxRetries = true
        } else {
          const parsed = Number(trimmed)
          this.stagedMaxRetries = parsed
          this.stagedClearMaxRetries = false
        }
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.stagedMode === undefined && this.stagedMaxRetries === undefined && !this.stagedClearMaxRetries && !this.failed) return
        this.stagedMode = undefined
        this.stagedMaxRetries = undefined
        this.stagedClearMaxRetries = false
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write the staged values as one namespace mutation, then re-seed from what
   * the Host accepted. Normal mode with no stored policy writes the whole
   * object (schemastery defaults fill the rest); an existing normal policy
   * mutates only `maxRetries`, so the card never clobbers fields it does not
   * show. The outcome is read back from the user layer.
   */
  async save(): Promise<void> {
    const state = this.projection()
    if (!state.dirty || state.invalid || this.saving) return
    this.saving = true
    this.failed = false
    this.publish()
    const mode = this.stagedMode ?? this.committed().mode
    const policy = this.scope.getSnapshot().value?.retryPolicy
    const hasStoredNormal = policy !== undefined && policy.mode === 'normal'
    const normalValue = {
      mode: 'normal' as const,
      ...this.stagedClearMaxRetries || this.stagedMaxRetries === undefined ? {} : { maxRetries: this.stagedMaxRetries },
    }
    const ops = mode === 'always'
      ? [{ op: 'set' as const, path: ['retryPolicy'], value: { mode: 'always' } }]
      : hasStoredNormal && !this.stagedClearMaxRetries && this.stagedMaxRetries !== undefined
        ? [{ op: 'set' as const, path: ['retryPolicy', 'maxRetries'], value: this.stagedMaxRetries }]
        : [{ op: 'set' as const, path: ['retryPolicy'], value: normalValue }]
    await this.scope.mutate(ops)
    const user = this.scope.getSnapshot().user as { retryPolicy?: unknown } | undefined
    const written = JSON.stringify(user?.retryPolicy)
    const expected = JSON.stringify(mode === 'always'
      ? { mode: 'always' }
      : hasStoredNormal && !this.stagedClearMaxRetries && this.stagedMaxRetries !== undefined
        ? { ...policy, maxRetries: this.stagedMaxRetries }
        : normalValue)
    const landed = written === expected
    this.saving = false
    if (landed) {
      this.stagedMode = undefined
      this.stagedMaxRetries = undefined
      this.stagedClearMaxRetries = false
    }
    this.failed = !landed
    this.publish()
  }
}
