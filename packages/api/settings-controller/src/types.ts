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
  /**
   * 这一节名下可以各自单独写经验的能力（一个主题一行），没有子主题时是空数组。
   * 见 `@deepseek-ai/dsh-system-prompt` 的 `PromptSectionView.subjects`。
   */
  readonly subjects: readonly string[]
}

/**
 * 反思文档里属于某一个主题的经验。
 *
 * 主题键大多就是提示词分段名（`tool:read`、`mcp:github`、`computer:policy`），
 * 所以界面拿到它就能直接和"这次装配里有哪些能力"对上号，注入侧也不必再翻译一次
 * 命名。MCP 工具是唯一的例外：它的主题键是公开工具名（`mcp__github__search`），
 * 挂在 `mcp:github` 那一节名下，由分段自己声明的 `subjects` 认领。
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
