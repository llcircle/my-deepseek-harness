/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/** One prompt section projected for editing surfaces. */
export interface PromptSectionView {
  readonly name: string
  readonly en: string
  readonly zh: string
  readonly editable: boolean
}

/**
 * 反思文档里属于某一个主题的经验。
 *
 * 主题键就是提示词分段名（`tool:read`、`mcp:github`、`computer:policy`），
 * 所以界面拿到它就能直接和"这次装配里有哪些能力"对上号，注入侧也不必再翻译
 * 一次命名。
 */
export interface ReflectionBlockView {
  /** Section name these lessons attach to. */
  readonly subject: string
  /** Lessons text; empty means the subject has no recorded experience. */
  readonly text: string
}

/** One journaled tool or MCP failure. */
export interface ToolErrorView {
  readonly time: string
  readonly sessionId: string
  readonly seq: number
  readonly name: string
  readonly callId: string
  readonly text: string
}
