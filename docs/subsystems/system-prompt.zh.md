# 系统提示词组装

[English](system-prompt.md) | 中文

[system-prompt 包](../../packages/core/system-prompt)负责管理提示词贡献者与一次组装调用之间交换的数据。该包的 [README](../../packages/core/system-prompt/README.zh.md) 记录注册、排序、作用域与渲染行为；本页记录各插件实现或传递的确切跨包类型。

源码：[`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)。

## 组装上下文

`AssembleContext` 标识一次组装所解析的作用域层，并可携带该请求的显式控制信号。它可合并扩展：`dsh-agent` 添加可选字段 `agent`，用于携带当前的 agent（智能体）实例；`assembleContextFor(agent, signal)` 则一起设置这些显式字段。裸组装既没有作用域，也没有信号。

```ts type-equiv
/** Merge-extensible context for one prompt assembly. */
interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Session workspace used to resolve per-session prompt file configuration. */
  cwd?: string
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
}
```

## 工具提供方结果

`ToolProviderResult.schemas` 是当前组装中对模型可见的工具 schema 集合。`knownNames` 是提供方在限制前的名称全集，用于区分「配置名拼写错误」与「已知工具在此作用域中被有意隐藏」。

```ts type-equiv
/** Tool schemas visible in one assembly and their pre-restriction name set. */
interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}
```

## 提示词段落

导出的 `PERSONA_PREFIX_SECTION`（`deployment:persona-prefix`）与 `PERSONA_SUFFIX_SECTION`（`deployment:persona-suffix`）为全局配置和带作用域贡献所共享的段落命名。它们对应的 `PromptSectionOrderName` 项为 `DEPLOYMENT_PERSONA_PREFIX` 与 `DEPLOYMENT_PERSONA_SUFFIX`；[包 README](../../packages/core/system-prompt/README.zh.md#configure-the-prompt)规定其位置与模板配置。

`PromptSection` 是一份只读的同进程注册约定。其文本可以是静态的，也可以从当前组装上下文动态解析。各段先按 order 升序排列，再按名称的代码单元顺序排列；仓库贡献方通过 `getSectionOrder()` 解析服务持有的具名分配。Runtime-context 贡献方通过 `getContextOrder()` 解析独立分配。协作式组装完成后，一个有效的 `complete` 段会成为唯一的提示词段落。agent loop（智能体循环）用 `renderPrompt` 渲染组装后的各段，并把文本作为 `system/message` surface 节点提交——首个步骤作为 surface 第 0 号节点追加，之后在渲染文本变化时原地替换，或者当已准备调用声明 `systemPromptUpdate: 'in-history'` 时，在序列延续期间把非空更新追加到已缓存历史之后——因此提示词作为派生历史中的消息而不是请求字段到达模型（[决策](../../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.zh.md)；[决策规则](../../packages/core/agent-loop/README.zh.md#understand-the-implementation)）。

```ts type-equiv
/** One contributed section of the system prompt (registry input). */
interface PromptSection {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
  readonly name: string
  /**
   * Sections are concatenated in ascending order. Equal orders use code-unit
   * name order.
   */
  readonly order: number
  /**
   * Static text or a provider evaluated at each assembly with that assembly's
   * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
   * interpolated later, by {@link renderPrompt}, unless `interpolate` is false.
   */
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
}
```

## 动态提示词上下文

`PromptContext` 是与 `PromptSection` 对应的缓存安全结构。组装会解析这些贡献并排序；agent loop（智能体循环）仅在完整当前快照发生变化或被压缩（compaction）移除时，才会将其记录在保留的模型历史之后。

```ts type-equiv
/** Dynamic model context materialized as a durable user-role snapshot. */
interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsystemprompt--systemprompt"></a>

### `ctx.systemPrompt` — `SystemPrompt`

Registry service for the prompt inputs assembled before each model step.

```ts cordis-catalog
/**
 * Register an ordered prompt section in the calling context's scope. A scoped
 * section shadows a global section with the same name; duplicates within one
 * layer and non-finite orders throw. Registration and disposal emit
 * `system-prompt/change`.
 * @param section - the section to register.
 * @returns the exact Cordis effect disposer.
 */
section(section: PromptSection): () => void

/**
 * Resolve the centrally owned placement of a repository prompt section.
 * @param name - stable section placement name.
 * @returns the section's numeric sort order.
 */
getSectionOrder(name: PromptSectionOrderName): number

/**
 * List globally registered section names for prompt editing surfaces.
 *
 * This is the **global view** and deliberately excludes scoped registrations.
 * To learn "which sections an editor may change", use {@link sectionTexts},
 * which folds scopes in — the two cover different sets by design, and turning
 * this one into a union would make "what did the global layer register"
 * unanswerable.
 * @returns sorted section names visible to unscoped assemblies.
 */
sectionNames(): string[]

/**
 * Project the sections a Web editor may address: the global layer plus every
 * scope's own first-seen contribution, in one merged view. Static sections
 * include their current text; dynamic sections stay visible but not editable.
 *
 * Scoped sections must be listed alongside them, or the editing surface would
 * miss a whole family of capabilities: every `tool:<name>` registers in the
 * agent scope, so reading the global layer alone concludes "this deployment
 * has no tools at all". Listing them is safe — overrides apply by name to the
 * **merged** sections in the final assembly step, so scoped sections are just
 * as editable.
 * @param cwd - session workspace whose per-session prompt file supplies the
 * Chinese column; omitted reads leave that column empty.
 * @returns sorted section views for prompt editing.
 */
async sectionTexts(cwd?: string): Promise<PromptSectionView[]>

/**
 * Install runtime-editable section replacements when the deployment mounts settings.
 * @param owner - consumer context used for section lifetime.
 * @param settings - the optional settings provider to install into.
 */
installOverrides( owner: Context, settings: PromptOverridesSettingsInstaller, ): void

/**
 * Adopt the source that reads the interface language.
 *
 * The registry does not know the concept of "settings" — it never injects a
 * settings service, because prompt assembly must run in deployments that have
 * none (headless, ACP, unit tests). So the language is pushed in by the
 * assembling side: the settings bridge registers "what the current interface
 * language is" at mount time, and assembly reads it once per request. One read
 * per request with no caching is what lets a language the user just changed in
 * the browser take effect on the next request instead of requiring a restart.
 *
 * @param source - reads the current interface language tag; empty means no settings service.
 */
adoptLocaleSource(source: () => string | undefined): void

/**
 * The prompt language in effect: an explicit config value wins, otherwise it
 * follows the interface language, and with neither it is `en`.
 * @returns `zh` or `en`.
 */
activeLocale(): PromptLocale

/**
 * Resolve the centrally owned placement of a repository runtime context.
 * @param name - stable context placement name.
 * @returns the context's numeric sort order.
 */
getContextOrder(name: PromptContextOrderName): number

/**
 * Register ordered dynamic context in the calling context's scope. Scoped
 * entries shadow global entries with the same name.
 * @param context - the context contribution to register.
 * @returns the exact Cordis effect disposer.
 */
context(context: PromptContext): () => void

/**
 * Suppress every dynamic runtime-context contribution in the calling
 * context's scope without changing the services that own or enforce those
 * facts. Multiple suppressors remain independently disposable.
 * @returns the exact Cordis effect disposer.
 */
suppressRuntimeContext(): () => void

/**
 * Suppress one named prompt section in the calling context's scope: the name
 * disappears from every assembly that scope takes part in, no matter which
 * layer registered it — the global one, an ancestor scope, or this scope.
 *
 * This is not the same as same-name shadowing through {@link section}, and the
 * two are not substitutes: shadowing asks you to supply new body text, which
 * suits "say it my own way"; suppression states "this section does not exist
 * in this scope", which suits a single-purpose agent that wants very few
 * prompt sections. Both affect assembly only and unregister nobody's
 * registration — a suppressed section still appears in parent and sibling
 * scope assemblies.
 *
 * The reach is the whole chain: a suppression declared at any layer hides the
 * section from this scope's assemblies, and there is no inverse
 * "unsuppress" syntax. This shares its origin with
 * {@link suppressRuntimeContext} — "from this scope downward, this block does
 * not exist".
 * @param name - the section name to suppress.
 * @returns the exact Cordis effect disposer.
 */
suppressSection(name: string): () => void

/**
 * Register a tool-schema provider in the calling context's scope. Global and
 * matching scoped providers both contribute; returning the reserved
 * {@link TOOL_ORDER_REST} name makes assembly fail.
 * @param provider - evaluated for each assembly with its context.
 * @returns the exact Cordis effect disposer.
 */
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void

/**
 * Register a per-section reflection source. Every source is consulted for
 * every section; a non-blank answer is appended below that section's own
 * text. Appending happens after user overrides and before empty optional
 * sections are dropped, and it never resurrects a section whose own text is
 * blank — an ability that is not composed in this assembly must not come back
 * just because an old lesson about it is still on disk.
 * @param source - consulted per section name on each assembly.
 * @returns the exact Cordis effect disposer.
 */
reflectionSource(source: PromptReflectionSource): () => void

/**
 * Register a prompt variable in the calling context's scope. Scoped values
 * shadow globals; invalid or duplicate names throw. A provider may return
 * `undefined`, but rendering a section that references that value then fails.
 * @param name - the `[a-z][a-z0-9_]*` reference name.
 * @param provider - evaluated for each assembly.
 * @returns the exact Cordis effect disposer.
 */
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void

/**
 * Assemble global and scoped providers, detach tool parameters, apply
 * canonical ordering, then run the assembly waterfall. Scoped sections and
 * variables shadow globals. The returned waterfall value is authoritative
 * except that an effective complete section is restored afterwards as the
 * sole prompt section.
 * @param context - the optional scope and plugin-defined assembly fields.
 * @returns the post-waterfall assembly with any complete prompt enforced.
 */
async assemble(context: AssembleContext = {}): Promise<PromptAssembly>
```

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)

<a id="system-prompt-events"></a>

### `system-prompt/*` events

<a id="system-promptassemble--waterfall"></a>

#### `system-prompt/assemble` — waterfall

Expert waterfall over the assembled sections, contexts, tools, and variables. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners receive only that scope's assemblies. The returned value is authoritative. A supplied signal controls only this explicit assembly request and must not be retained to control later turns. A registered complete section is restored after this waterfall, so listeners cannot add to or replace that scope's system prompt.

```ts cordis-catalog
/**
 * Expert waterfall over the assembled sections, contexts, tools, and variables.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): scoped listeners
 * receive only that scope's assemblies. The returned value is authoritative.
 * A supplied signal controls only this explicit assembly request and must not
 * be retained to control later turns. A registered complete section is
 * restored after this waterfall, so listeners cannot add to or replace
 * that scope's system prompt.
 * @param assembly - the mutable assembly built from registered providers.
 * @param context - the caller's per-assembly context.
 * @mode waterfall
 */
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
```

Types: [Scoped](scope.zh.md)

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)

<a id="system-promptchange--emit"></a>

#### `system-prompt/change` — emit

Emitted when any prompt provider changes. This registry notification is unfiltered because a global change affects every scope.

```ts cordis-catalog
/**
 * Emitted when any prompt provider changes. This registry notification is
 * unfiltered because a global change affects every scope.
 * @mode emit
 */
'system-prompt/change'(): void
```

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts)
<!-- END GENERATED cordis-surface -->
