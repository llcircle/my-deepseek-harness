# System Prompt Assembly

English | [中文](system-prompt.zh.md)

The [system-prompt package](../../packages/core/system-prompt) owns the data exchanged between prompt contributors and one assembly call. The package [README](../../packages/core/system-prompt/README.md) documents registration, ordering, scoping, and rendering behavior; this page records the exact cross-package types that plugins implement or pass.

Source: [`packages/core/system-prompt/src/index.ts`](../../packages/core/system-prompt/src/index.ts).

## Assembly context

`AssembleContext` identifies the scope layer one assembly resolves and may carry the explicit control signal for that request. It is merge-extensible: `dsh-agent` adds the optional live `agent` field, and `assembleContextFor(agent, signal)` sets the explicit fields together. A bare assembly has neither scope nor signal.

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
  /**
     * The active language for this assembly, written by the registry once it resolves one.
     * Sections and context providers pick their wording from it; callers neither need nor
     * should pass it themselves.
     */
  locale?: PromptLocale
}
```

## Tool-provider result

`ToolProviderResult.schemas` is the model-visible set for the current assembly. `knownNames` is the provider's pre-restriction name universe used to distinguish a configured-name typo from a known tool that is deliberately hidden in this scope.

```ts type-equiv
/** Tool schemas visible in one assembly and their pre-restriction name set. */
interface ToolProviderResult {
  /** The schemas this provider contributes to THIS assembly. */
  readonly schemas: readonly ToolSchema[]
  /** The pre-restriction name universe for config validation (defaults to `schemas`' names). */
  readonly knownNames?: readonly string[]
}
```

## Prompt sections

The exported `PERSONA_PREFIX_SECTION` (`deployment:persona-prefix`) and `PERSONA_SUFFIX_SECTION` (`deployment:persona-suffix`) name the slots shared by global configuration and scoped contributions. Their `PromptSectionOrderName` entries are `DEPLOYMENT_PERSONA_PREFIX` and `DEPLOYMENT_PERSONA_SUFFIX`; the [package README](../../packages/core/system-prompt/README.md#configure-the-prompt) owns their placement and template configuration.

`PromptSection` is a readonly same-process registration contract. Its text may be static or resolved from the current assembly context. Sections sort by ascending order and then code-unit name; repository contributors resolve the service-owned named allocation through `getSectionOrder()`. Runtime-context contributors resolve their independent allocation through `getContextOrder()`. One effective `complete` section becomes the sole prompt section after cooperative assembly. agent-loop renders the assembled sections with `renderPrompt` and commits the text as a `system/message` surface node — appended as surface node 0 on the first step, then replaced in place when the rendered text changes or, when the prepared call declares `systemPromptUpdate: 'in-history'`, appended after the cached history for non-empty updates in a continuing series — so the prompt reaches the model as a message of derived history rather than as a request field ([decision](../../.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md); [decision rule](../../packages/core/agent-loop/README.md#understand-the-implementation)).

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
   * The abilities under this section that each keep their own lessons, one
   * reflection-document subject key apiece (see {@link PromptReflectionSource}).
   *
   * An MCP server owns one prompt section but a dozen tools. A tool's lessons
   * belong inside its server's section, yet the editing surface has to know
   * which tools sit under it — otherwise it could only offer one field for the
   * whole section. Declared here, the surface expands one section into several
   * rows, so editing one tool's lessons cannot touch another's.
   *
   * Omitted means the section has no sub-subjects, as almost every section is.
   */
  readonly subjects?: (context: AssembleContext) => readonly string[]
  /**
   * Treat this contribution as the complete system prompt. Assembly still
   * runs the cooperative waterfall so tools, contexts, and variables can be
   * resolved, then restores this exact section as the sole prompt section.
   * More than one effective complete section makes assembly fail.
   */
  readonly complete?: boolean
}
```

## Dynamic prompt context

`PromptContext` is the cache-safe counterpart to `PromptSection`. The assembly resolves and orders these contributions, while agent-loop logs their complete current snapshot after retained model history only when it changed or compaction removed it.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Scoped](scope.md)

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
