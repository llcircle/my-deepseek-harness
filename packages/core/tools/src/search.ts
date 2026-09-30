/**
 * `tool_search`: the model-facing fetch that turns an on-demand tool into a
 * resident one, plus the composition-side row declaring WHICH tools are on
 * demand.
 *
 * ## Why the registry owns this
 *
 * A schema is withheld in exactly one place — `ToolRuntime.wireSchemas` — and
 * the registry is the only thing that knows both the full catalog and the
 * calling scope. Splitting the fetch into its own package would mean exporting
 * that whole surface (`defer` / `loadDeferred` / `deferredTools`) across a
 * package boundary only for the fetch to hand it straight back, so the fetch
 * lives here and reaches the layer store directly.
 *
 * ## The two categories
 *
 * Every tool is RESIDENT by default; `defer` names the on-demand half. That
 * direction matters: a deployment that says nothing keeps the whole catalog,
 * and a preset that wants a smaller catalog names what it is willing to fetch
 * rather than what it is willing to keep.
 *
 * ## What fetching costs, honestly
 *
 * A fetch changes the request's tool list, so the next request is a new cache
 * prefix — the same price claude-code and codex pay for the same feature. That
 * is why the index section below is short: the win is that a session which
 * never needs `web_fetch` never pays for its schema, and the loss is bounded to
 * the step that actually asks for one.
 *
 * ## Why the index is a runtime context, not a section
 *
 * The index names the live withheld set, so its text changes the moment a
 * plugin defers something and again on every fetch. A `section` would put that
 * varying text in the **stable prefix** — ahead of all history — so each change
 * would re-charge the entire conversation to save one schema, which is the
 * opposite of what this module is for.
 *
 * It is therefore registered as a `context`: contexts are appended to the tail
 * as a runtime-context snapshot, so a change costs one appended message and
 * leaves the cached prefix intact. The bound on this module's cost is then the
 * honest one — the tool list itself — rather than a whole-prefix rewrite.
 *
 * @module @deepseek-ai/dsh-tools/search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Imported by package name rather than `./schema.ts` so this sub-entry shares
// the parent's runtime copy of the definition builder instead of compiling a
// second one into the tsc tree.
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-search'

/** Required services. */
export const inject = ['tools', 'systemPrompt']

/** Name of the fetch tool itself. Never deferrable: it is the only way back. */
export const TOOL_SEARCH_NAME = 'tool_search'

/** Prompt-section name carrying the on-demand index. */
export const ON_DEMAND_SECTION = 'tools:on-demand'

/**
 * Marker introducing the on-demand name list at the end of the index section.
 * Exported because the Chinese mirror in `dsh-system-prompt` captures the list
 * from it by pattern, and a reworded marker would silently drop that section
 * back to English.
 */
export const ON_DEMAND_MARKER = 'On demand: '

const DEFAULT_MAX_RESULTS = 5
const DEFAULT_HINT_CHARS = 100

/** Plugin config. */
export interface Config {
  /**
   * Tool names whose schemas this composition withholds until the model
   * fetches them. Unknown names are ignored (see `ToolRuntime.defer`), so a
   * preset may list a group whose rows a deployment leaves `disabled`.
   */
  defer?: string[]
  /** Cap on matches returned for one keyword query (default 5). */
  maxResults?: number
  /**
   * Cap on the per-tool hint in the index section (default 100 characters, cut
   * on a word boundary). The index is the one place an on-demand tool costs
   * anything before it is needed, so its budget is explicit.
   */
  hintChars?: number
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  defer: z.array(z.string()).default([]),
  maxResults: z.natural().min(1).default(DEFAULT_MAX_RESULTS),
  hintChars: z.natural().min(1).default(DEFAULT_HINT_CHARS),
})

/** Fully materialized config. */
interface ResolvedConfig {
  readonly defer: readonly string[]
  readonly maxResults: number
  readonly hintChars: number
}

/**
 * Validate config even when `apply` is called directly outside Loader
 * normalization: the schema's defaults only run through the Loader, so a
 * direct call must still reach the same resolved shape.
 * @param config - the row's config, possibly a direct-apply omission.
 * @returns the materialized policy.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  const hintChars = config.hintChars ?? DEFAULT_HINT_CHARS
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new TypeError('tool-search: maxResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(hintChars) || hintChars < 1) {
    throw new TypeError('tool-search: hintChars must be a positive safe integer')
  }
  return { defer: config.defer ?? [], maxResults, hintChars }
}

/**
 * One tool's complete schema, as the model must see it to make the call. The
 * index signature is what makes a match directly useful as a `JsonValue`: the
 * tool result carries these verbatim, so the shape the model reads is the
 * shape the registry holds.
 */
interface SchemaMatch {
  [key: string]: JsonValue
  readonly name: string
  readonly description: string
  /** The tool's JSON parameter schema, as the registry snapshots it for the wire. */
  readonly parameters: JsonValue
}

/** One on-demand tool plus the precomputed text keyword search ranks against. */
interface Candidate {
  readonly tool: SchemaMatch
  /** Whether this scope already fetched it. */
  readonly loaded: boolean
  readonly text: string
  readonly parts: readonly string[]
}

/** What one `tool_search` call found. */
interface SearchValue {
  readonly query: string
  /** Tools matched, with their complete schemas. */
  readonly matches: JsonValue[]
  /** Names a `select:` query asked for that match nothing on demand. */
  readonly missing: string[]
  /** Matched tools this scope had already fetched. */
  readonly alreadyLoaded: string[]
  /** How many tools this scope holds on demand, loaded or not. */
  readonly totalOnDemand: number
}

/**
 * Split a tool name into searchable words, so `web_fetch` is reachable from a
 * query phrased as `web fetch`.
 * @param toolName - the registered tool name.
 * @returns lowercased words, with underscores treated as separators.
 */
function nameParts(toolName: string): string[] {
  return toolName.toLowerCase().split('_').filter(part => part.length > 0)
}

/**
 * Every searchable word a tool contributes: its name in both spellings, its
 * description, and every parameter name and description it declares.
 * Parameters matter because a model often searches for what it wants to do
 * (`wait`, `timeout`, `signal`) rather than for the tool that does it.
 * @param tool - the on-demand tool.
 * @returns lowercased text to match a query against.
 */
function searchText(tool: SchemaMatch): string {
  const parts: string[] = [tool.name, nameParts(tool.name).join(' '), tool.description]
  appendSchemaText(tool.parameters, parts)
  return parts.filter(part => part.length > 0).join(' ').toLowerCase()
}

/**
 * Append one JSON Schema node's property names and descriptions, recursively.
 * @param schema - any node of the parameter schema.
 * @param parts - accumulator.
 */
function appendSchemaText(schema: unknown, parts: string[]): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return
  const node = schema as Record<string, unknown>
  if (typeof node.description === 'string') parts.push(node.description)
  const properties = node.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      parts.push(propertyName)
      appendSchemaText(propertySchema, parts)
    }
  }
  if (Array.isArray(node.items)) {
    for (const item of node.items) appendSchemaText(item, parts)
  } else {
    appendSchemaText(node.items, parts)
  }
  if (Array.isArray(node.oneOf)) {
    for (const variant of node.oneOf) appendSchemaText(variant, parts)
  }
}

/** Escape a term for literal use inside a word-boundary pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile one term into its literal word-boundary pattern. */
function termPattern(term: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`)
}

/**
 * Score one tool against a query's terms. Word-boundary matches keep `read`
 * from matching `thread`, and a whole-word name hit outranks a description hit
 * because a model naming a thing is stronger evidence than prose containing
 * the word.
 * @param candidate - the tool, with its precomputed text and parts.
 * @param terms - the query's scoring terms.
 * @param required - terms that must all appear (the `+term` form).
 * @param patterns - the compiled word-boundary pattern per term.
 * @returns the score, or 0 when the tool is not a candidate at all.
 */
function scoreTool(
  candidate: Candidate,
  terms: readonly string[],
  required: readonly string[],
  patterns: ReadonlyMap<string, RegExp>,
): number {
  for (const term of required) {
    const pattern = patterns.get(term) ?? termPattern(term)
    if (!pattern.test(candidate.text)) return 0
  }
  let score = 0
  for (const term of terms) {
    if (candidate.parts.includes(term)) score += 10
    else if (candidate.parts.some(part => part.includes(term))) score += 5
    if ((patterns.get(term) ?? termPattern(term)).test(candidate.text)) score += 2
  }
  return score
}

/** What one query resolved to. */
interface SearchResult {
  readonly matches: SchemaMatch[]
  readonly missing: string[]
  readonly alreadyLoaded: string[]
}

/**
 * Resolve one query against the on-demand set.
 * @param query - the raw model query.
 * @param candidates - every on-demand tool in scope, with load state.
 * @param maxResults - keyword-match cap.
 * @returns the matches, the names that matched nothing, and which were already loaded.
 */
function search(query: string, candidates: readonly Candidate[], maxResults: number): SearchResult {
  const lower = query.trim().toLowerCase()

  // `select:` takes exact names, comma-separated. A name that is not on demand
  // is reported rather than silently dropped, so a model that mis-remembered
  // learns which name it missed instead of seeing an empty result.
  const select = /^select:(.+)$/i.exec(query.trim())
  if (select !== null) {
    const matches: SchemaMatch[] = []
    const missing: string[] = []
    const alreadyLoaded: string[] = []
    for (const requested of (select[1] ?? '').split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)) {
      const hit = candidates.find(entry => entry.tool.name.toLowerCase() === requested.toLowerCase())
      if (hit === undefined) {
        missing.push(requested)
        continue
      }
      matches.push(hit.tool)
      if (hit.loaded) alreadyLoaded.push(hit.tool.name)
    }
    return { matches, missing, alreadyLoaded }
  }

  // A bare tool name is what models actually type. Answering it exactly costs
  // one lookup and removes a whole class of retry loops.
  const exact = candidates.find(entry => entry.tool.name.toLowerCase() === lower)
  if (exact !== undefined) {
    return {
      matches: [exact.tool],
      missing: [],
      alreadyLoaded: exact.loaded ? [exact.tool.name] : [],
    }
  }

  const words = lower.split(/\s+/).filter(word => word.length > 0)
  const required = words.filter(word => word.startsWith('+') && word.length > 1).map(word => word.slice(1))
  const terms = [...required, ...words.filter(word => !(word.startsWith('+') && word.length > 1))]
  if (terms.length === 0) return { matches: [], missing: [], alreadyLoaded: [] }
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    if (!patterns.has(term)) patterns.set(term, termPattern(term))
  }
  const ranked = candidates
    .map(candidate => ({ candidate, score: scoreTool(candidate, terms, required, patterns) }))
    .filter(row => row.score > 0)
    .sort((left, right) => right.score - left.score
      || left.candidate.tool.name.localeCompare(right.candidate.tool.name))
    .slice(0, maxResults)
  return {
    matches: ranked.map(row => row.candidate.tool),
    missing: [],
    alreadyLoaded: ranked.filter(row => row.candidate.loaded).map(row => row.candidate.tool.name),
  }
}

/**
 * Render one index entry: the name plus a bounded first sentence of its
 * description. The cap is what keeps "on demand" from costing as much as
 * "resident" would have; the FIRST sentence is used because tool descriptions
 * are written to lead with the summary.
 * @param description - the tool's full description.
 * @param limit - maximum characters of hint text.
 * @returns the hint, cut on a word boundary with an ellipsis when truncated.
 */
function hintOf(description: string, limit: number): string {
  const trimmed = description.trim()
  const firstSentence = /^[^.!?]*[.!?]/.exec(trimmed)?.[0] ?? trimmed
  const single = firstSentence.replace(/\s+/g, ' ').trim()
  if (single.length <= limit) return single
  const cut = single.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  return `${boundary > limit / 2 ? cut.slice(0, boundary) : cut}`.trimEnd() + '…'
}

/**
 * Render the fetch result: a header, then one `<function>` line per match.
 * The schemas are also returned as structured output, but the text is what the
 * model reads, so it repeats them in the same shape the tool list uses.
 * @param value - the structured result.
 * @returns the model-facing text.
 */
function renderResult(value: SearchValue): string {
  const missed = value.missing.length === 0 ? '' : ` Not on demand: ${value.missing.join(', ')}.`
  if (value.matches.length === 0) {
    const known = value.totalOnDemand === 0
      ? 'This agent holds no tools on demand.'
      : `${value.totalOnDemand} tool(s) are on demand — retry with keywords, or with select:<name>.`
    return `No on-demand tool matched ${JSON.stringify(value.query)}. ${known}${missed}`
  }
  const loaded = value.alreadyLoaded.length === 0
    ? 'Their schemas are now in your tool list and are callable exactly like any other tool.'
    : `Already loaded: ${value.alreadyLoaded.join(', ')}. The rest are now in your tool list and are callable exactly like any other tool.`
  const lines = value.matches.map(match => `<function>${JSON.stringify(match)}</function>`)
  return `${value.matches.length} on-demand tool(s) matched ${JSON.stringify(value.query)}. ${loaded}${missed}\n${lines.join('\n')}`
}

/** The fetch tool's own description; states the consequence of not fetching. */
const SEARCH_DESCRIPTION =
  'Fetch the full schema of an on-demand tool so you can call it. On-demand tools are named in your '
  + 'instructions but carry no parameter schema, so a call to one fails until you fetch it here; after a '
  + 'fetch it is callable exactly like any tool already in your list. Queries: a bare tool name; '
  + '`select:name` or `select:a,b` for exact names; keywords to search; `+word` to require a word. '
  + 'Returns each match\'s complete JSON schema. Searching again for a tool you already fetched is harmless.'

/**
 * Declare the on-demand set for every agent this composition covers, register
 * the fetch tool, and index what is on demand.
 * @param ctx - the mounting composition's scope context (a preset's standing scope).
 * @param config - which tools are on demand, and the index budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  // The declaration is scoped to this composition, so a preset that holds
  // `web_fetch` on demand leaves another preset's `web_fetch` resident.
  if (resolved.defer.length > 0) ctx.tools.defer(resolved.defer)

  ctx.systemPrompt.context({
    name: ON_DEMAND_SECTION,
    order: ctx.systemPrompt.getContextOrder('TOOLS_ON_DEMAND'),
    // Dynamic per scope: a fetch drops its name from here, so the index always
    // names exactly what the model would still have to fetch. Empty text
    // renders nothing, which is what a composition with no deferrals gets.
    text: (context) => {
      const pending = ctx.tools.deferredTools(context.scope).filter(entry => !entry.loaded)
      if (pending.length === 0) return ''
      const lines = pending.map(entry =>
        `${entry.definition.name} — ${hintOf(entry.definition.description, resolved.hintChars)}`)
      return 'Some tools are not in the list above: their schemas are sent only after you ask for them, '
        + `which is what keeps this catalog small. Call \`${TOOL_SEARCH_NAME}\` with keywords to search them, `
        + 'or with the query `select:<name>` to fetch exact names.\n'
        + ON_DEMAND_MARKER + lines.join('\n')
    },
  })

  ctx.tools.register(defineTool({
    name: TOOL_SEARCH_NAME,
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'A bare tool name, `select:name` (comma-separated for several), keywords, or `+word` to require a word.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          matches: { type: 'array', required: true, items: { type: 'json' } },
          missing: { type: 'array', required: true, items: { type: 'string' } },
          alreadyLoaded: { type: 'array', required: true, items: { type: 'string' } },
          totalOnDemand: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text' as const, text: renderResult(value) }],
    },
    // A fetch writes the calling scope's loaded set. Two overlapping fetches
    // would each read the same pre-mutation state and then insert the same
    // name — a duplicate, not a double fetch. Exclusive dispatch removes the
    // interleaving instead of tolerating it.
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error(`${TOOL_SEARCH_NAME} requires a calling agent (exec.agent was undefined)`)
      }
      // Read and write through the AGENT's own context: one agent's research
      // must not spend another agent's tool budget. The WRITE picks that up
      // from the calling context by itself, but the read takes an explicit
      // scope — and its omission means the deployment default, which is the
      // wrong answer for an executing tool.
      const agentCtx = agent.ctx
      const agentScope = scopeOf(agentCtx)
      const candidates = agentCtx.tools.deferredTools(agentScope).map((entry) => {
        const tool: SchemaMatch = {
          name: entry.definition.name,
          description: entry.definition.description,
          // The registry snapshots parameter schemas for the wire, so this is
          // JSON by construction; the cast only records that guarantee.
          parameters: entry.definition.parameters as JsonValue,
        }
        return { tool, loaded: entry.loaded, text: searchText(tool), parts: nameParts(tool.name) }
      })
      const found = search(args.query, candidates, resolved.maxResults)
      // Only the not-yet-loaded matches are recorded: re-inserting a name the
      // scope already holds would be a duplicate declaration, not a re-fetch.
      const fresh = found.matches
        .map(match => match.name)
        .filter(matchName => !found.alreadyLoaded.includes(matchName))
      if (fresh.length > 0) agentCtx.tools.loadDeferred(fresh)
      return Promise.resolve({
        query: args.query,
        matches: found.matches,
        missing: found.missing,
        alreadyLoaded: found.alreadyLoaded,
        totalOnDemand: candidates.length,
      } satisfies SearchValue)
    },
  }))
}
