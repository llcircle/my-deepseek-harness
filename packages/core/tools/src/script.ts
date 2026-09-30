/**
 * `script`: ONE resident entry whose body is a line-per-action script — plus the
 * composition row that mounts it.
 *
 * ## Why one script entry, and not one tool per action
 *
 * A capability that arrives MID-SESSION cannot add a tool without moving the
 * request's `tools` array, and `tools` sits at the very front of the request, so
 * the whole cached prefix is re-billed on the step the capability turns on
 * (`request/header` records `reason=change` for exactly that). A script entry
 * takes the other direction: one small schema that is resident from the first
 * step to the last, while WHAT the script can do is decided by whichever
 * capability is enabled. Enabling one then costs a trailing runtime-context
 * snapshot instead of a new prefix.
 *
 * This is not the trade PTC's "translate the catalog into an SDK" makes. That
 * one is a type PROJECTION of every schema and measures larger than the JSON it
 * replaces; here what is projected away is the way to EXPRESS a call, not the
 * schema — a dozen lines of syntax carried by the capability's own prompt
 * material, which enters the prompt only when the capability does.
 *
 * ## Why the verbs are contributions
 *
 * The tool owns the grammar (one action per line, positional or `name=value`
 * arguments, comments, string escapes), the whole-script-first parse, and the
 * per-step dispatch. WHICH actions exist is not its business: a capability calls
 * `ctx.tools.contributeScript(...)` with a verb table and gets the entry, the
 * withholding, and the direct-call refusal for free. The next capability that
 * wants a script surface writes a verb table, not a second tool — and the
 * description stays short for the same reason. It would otherwise carry one
 * capability's prose forever, when that prose belongs with the capability, in
 * the material appended to the prompt while the capability is enabled.
 *
 * ## Why the row is a preset row
 *
 * The host plane's rows register onto the process's GLOBAL layer, which no
 * preset owns and every preset inherits — a registration there reaches every
 * session and bypasses the restriction that lets `minimal` pin its catalog to
 * one tool (this repo asserts the global layer stays empty). "A model-facing
 * tool belongs to a preset" is the rule here: `read`, `edit`, and `web_fetch`
 * are each declared by the presets that want them. This row is declared the same
 * way, and a preset that does not declare it gets no script entry at all.
 *
 * The row registers only when at least one capability has contributed a verb
 * table, so a deployment whose capabilities are all `disabled` (on a host that
 * cannot run them, say) gets the same catalog it would have had without the row.
 * Contributions are a composition-time fact: a capability mounted in the host
 * plane registers its verbs at boot, before any preset's standing mount runs.
 *
 * ## Why each step is still dispatched separately
 *
 * A coarse-grained body (Codex's `exec` shape) saves tokens but hides behaviour
 * inside model-written code, so audit and approval can only pass the whole thing
 * or refuse it. Scripts here are parsed line by line and each line goes through
 * `registry.execute` as a real, `parent`-carrying nested dispatch, so:
 *
 * - every action is still a `tool/ptc-dispatch-start` / `tool/ptc-dispatch` pair,
 *   the UI draws the sub-call tree, and approval can still act per action;
 * - argument validation, concurrency classification, and the action's own result
 *   envelope all reuse the registered tool definitions — there is no second
 *   implementation;
 * - those definitions stay registered (they are the dispatch targets); only
 *   their schemas are withheld from the request body.
 *
 * ## Why the whole script is parsed first
 *
 * A syntax error is reported before ANY action runs: a typo on line 5 must not
 * follow four clicks that already landed on the user's desktop. Runtime failures
 * (a provider that died, say) stop at the failing line instead — the later
 * coordinates assume the earlier ones succeeded, so carrying on is the more
 * dangerous of the two.
 *
 * ## Syntax
 *
 * One action per line; `#` starts a comment; blank lines are ignored; double
 * quotes keep spaces and `#` and recognise `\n` `\t` `\\` `\"`. Arguments are
 * positional after the verb (`click 100 200`) or written `name=value`
 * (`click y=200 x=100`). Argument TYPES are not declared here: they come from the
 * target tool's own parameter schema, so adding a parameter to an action needs no
 * change to this file.
 *
 * @module @deepseek-ai/dsh-tools/script
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
// Imported by package name rather than a relative path so this sub-entry shares
// the parent's runtime copy of the definition builder instead of compiling a
// second one into the tsc tree (the `search.ts` precedent).
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  InferValue,
  ScriptVerb,
  ToolDefinition,
  ToolRunContext,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the `tool/ptc-dispatch-start` / `tool/ptc-dispatch` session
// event declarations this file appends (the nested-dispatch vocabulary lives in
// the tools package, and these two events are its generic "one nested call
// started/settled").
import type {} from '@deepseek-ai/dsh-tools/types'

/** Cordis plugin name. */
export const name = 'tool-script'

/** The registry is the only service this row needs: it reads the surface and registers into it. */
export const inject = ['tools']

/** The one model-facing name. Capabilities add actions to it; they never add tools beside it. */
export const SCRIPT_TOOL_NAME = 'script'

/**
 * Mount the script entry for the calling scope, plus the two consequences of the
 * contributed surface: the withheld names' schemas stay off the wire, and a
 * model-direct call to one of them is refused.
 *
 * All three registrations attach to the CALLER's context (the registry's effect
 * takes the caller's layer), so they unload with this preset's standing mount.
 *
 * @param ctx - the composition scope mounting this row.
 */
export function apply(ctx: Context): void {
  const surface = ctx.tools.scriptSurface()
  // No capability contributed: registering here would put a permanently useless
  // schema on the wire of every preset that mounts this row.
  if (Object.keys(surface.verbs).length === 0) return

  ctx.tools.register(createScriptTool(ctx.tools))

  if (surface.withheld.size === 0) return
  // Order does not matter between withholding and registration (the wire reads
  // the withheld table), and both tables merge down the scope chain, so a
  // withholding declared here covers actions registered into an agent scope.
  ctx.tools.defer([...surface.withheld])
  // Withholding only keeps a schema out of the request body; it does not refuse a
  // call — a withheld name stays registered and dispatchable, so a model that
  // emits it anyway would reach it. This guard turns "only a script can reach it"
  // from a comment into a fact: `parent` is set by every script line, and unset
  // for a model-direct call.
  ctx.tools.guard((exec) => {
    if (exec.parent !== undefined) return undefined
    const live = ctx.tools.scriptSurface()
    if (!live.withheld.has(exec.name)) return undefined
    const verbs = Object.keys(live.verbs).filter(verb => live.verbs[verb]?.tool === exec.name)
    const route = verbs.length === 0 ? '' : ` — write it as the line \`${verbs[0]}\``
    return `\`${exec.name}\` cannot be called directly: it is reachable only from inside a ${SCRIPT_TOOL_NAME} script${route}.`
  })
}

/** One parameter as read off a target tool's declared schema. */
export interface ScriptParameter {
  /** The declared type: `integer` / `number` / `boolean` / `array`; anything else stays a string. */
  readonly type?: string
  readonly required: boolean
}

/**
 * How the parser resolves the two things it does not own: which actions exist,
 * and what each action's target tool declares.
 *
 * The target lookup returns `undefined` for a tool that is not registered in the
 * current agent's scope (the capability is off, or this action has no
 * implementation on this host), so the whole script is refused at PARSE time
 * rather than after the first line has already run.
 */
export interface ScriptParseContext {
  /** Verbs available in this scope, keyed by what a script writes. */
  readonly verbs: Readonly<Record<string, ScriptVerb>>
  readonly parametersOf: (tool: string) => Readonly<Record<string, ScriptParameter>> | undefined
}

/**
 * Narrow a registered tool's parameter JSON Schema to the shape the parser needs.
 *
 * `ToolDefinition.parameters` holds the COMPILED JSON Schema — `{ type, properties,
 * required }` with `required` as a name list rather than a per-property boolean —
 * and the script layer only wants "name to type plus whether it is required", so
 * the conversion happens here rather than leaking the JSON Schema shape inward.
 *
 * @param declared - the `parameters` of the target tool definition.
 * @returns parameter names mapped to their spec.
 */
export function readScriptParameters(
  declared: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ScriptParameter>> {
  const properties = declared['properties']
  if (properties === null || typeof properties !== 'object') return {}
  const required = new Set(
    (Array.isArray(declared['required']) ? declared['required'] : [])
      .filter((name): name is string => typeof name === 'string'),
  )
  const found: Record<string, ScriptParameter> = {}
  for (const [name, node] of Object.entries(properties as Record<string, unknown>)) {
    const type = node !== null && typeof node === 'object' ? (node as { type?: unknown }).type : undefined
    found[name] = {
      ...typeof type === 'string' ? { type } : {},
      required: required.has(name),
    }
  }
  return found
}

/** One action parsed out of a script line. */
export interface ScriptStep {
  /** 1-based line number, so a failure can be traced back to the script. */
  readonly line: number
  /** The line with its comment and surrounding whitespace removed. */
  readonly source: string
  /** The verb as written, e.g. `click`. */
  readonly verb: string
  /** The registry tool it dispatches to, e.g. `computer_click`. */
  readonly tool: string
  /** Arguments, already coerced against the target tool's declarations. */
  readonly args: Readonly<Record<string, unknown>>
}

/** Escape table, in double quotes only. */
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', '\\': '\\', '"': '"' }

/** One token cut from a line: either `name=value` or a bare value. */
interface Token {
  readonly name?: string
  /**
   * Looks like `name=value`, but `name` is not a known parameter of this verb.
   *
   * Diagnostics only: for `click 1 2 buton=right` the real mistake is the
   * misspelled parameter name, not "too many positional arguments". The value is
   * kept whole regardless (`type a=b` has to type `a=b`), so this is a hint.
   */
  readonly looksNamed?: string
  /** The value, with quotes unwrapped and escapes resolved. */
  readonly value: string
}

/** The shape a parameter name has to have on the left of `=` to be readable as one. */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]*$/

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t'
}

/**
 * Cut the comment: everything from the first `#` outside quotes.
 *
 * @param line - one raw line.
 * @returns the part before the comment (not yet trimmed).
 */
function stripComment(line: string): string {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted && character === '\\') {
      index += 1
      continue
    }
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === '#' && !quoted) return line.slice(0, index)
  }
  return line
}

/**
 * Cut one line's body into tokens.
 *
 * The rules are deliberately few: whitespace separates; double quotes hold spaces
 * and `#` and resolve escapes; and `name=value` is only read as a named argument
 * when the text left of `=` is a KNOWN parameter of this verb — otherwise an
 * input like `type a=b` would be misread as one.
 *
 * @param body - the line after the comment is removed (the part after the verb).
 * @param known - this verb's parameter names.
 * @returns the tokens in order.
 * @throws when a double quote is left open; the caller adds the line number.
 */
function tokenize(body: string, known: ReadonlySet<string>): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < body.length) {
    while (index < body.length && isSpace(body[index])) index += 1
    if (index >= body.length) break

    // Name part: read bare characters, and only treat them as a parameter name
    // when they are immediately followed by `=` and are a known one.
    const nameStart = index
    while (index < body.length && !isSpace(body[index]) && body[index] !== '"' && body[index] !== '=') index += 1
    const candidate = body.slice(nameStart, index)
    const atEquals = index < body.length && body[index] === '='
    let name: string | undefined
    let looksNamed: string | undefined
    if (atEquals && known.has(candidate)) {
      name = candidate
      index += 1
    } else {
      index = nameStart
      if (atEquals && PARAMETER_NAME.test(candidate)) looksNamed = candidate
    }

    // Value part: read to whitespace, except that quoted runs keep their spaces.
    let value = ''
    while (index < body.length && !isSpace(body[index])) {
      const character = body[index] as string
      if (character !== '"') {
        value += character
        index += 1
        continue
      }
      index += 1
      while (index < body.length && body[index] !== '"') {
        const escaped = body[index] === '\\' ? ESCAPES[body[index + 1] ?? ''] : undefined
        if (escaped !== undefined) {
          value += escaped
          index += 2
          continue
        }
        value += body[index] as string
        index += 1
      }
      if (index >= body.length) throw new Error('unterminated double quote')
      index += 1
    }
    tokens.push({
      ...name === undefined ? {} : { name },
      ...looksNamed === undefined ? {} : { looksNamed },
      value,
    })
  }
  return tokens
}

/**
 * Coerce a bare string to the type its target parameter declares.
 *
 * @param raw - the value as written.
 * @param spec - the target tool's declaration for this parameter.
 * @param line - line number, for the error text.
 * @param name - parameter name, for the error text.
 * @returns the coerced value.
 */
function coerce(raw: string, spec: ScriptParameter | undefined, line: number, name: string): unknown {
  switch (spec?.type) {
    case 'integer':
    case 'number': {
      const parsed = Number(raw.trim())
      if (raw.trim() === '' || !Number.isFinite(parsed)) {
        throw new Error(`line ${line}: parameter \`${name}\` needs a number, got \`${raw}\``)
      }
      return parsed
    }
    case 'boolean': {
      if (raw === 'true') return true
      if (raw === 'false') return false
      throw new Error(`line ${line}: parameter \`${name}\` needs true or false, got \`${raw}\``)
    }
    case 'array':
      // List-valued parameters are written comma-separated: `key ctrl,s`.
      return raw.split(',').map(item => item.trim()).filter(item => item !== '')
    default:
      return raw
  }
}

/**
 * Bind one line's tokens to arguments: positional tokens fill the verb's
 * positional list in order, named ones set their parameter.
 *
 * @param verb - this line's verb.
 * @param tokens - the cut tokens.
 * @param parameters - the target tool's parameter spec.
 * @param line - line number, for the error text.
 * @param command - verb name, for the error text.
 * @returns the coerced arguments.
 */
function bindArguments(
  verb: ScriptVerb,
  tokens: readonly Token[],
  parameters: Readonly<Record<string, ScriptParameter>>,
  line: number,
  command: string,
): Record<string, unknown> {
  const bound = new Map<string, string>()
  let position = 0
  for (const token of tokens) {
    let target: string | undefined
    if (token.name !== undefined) {
      if (parameters[token.name] === undefined) {
        throw new Error(`line ${line}: \`${command}\` has no parameter \`${token.name}\`; available: ${Object.keys(parameters).join(', ')}`)
      }
      target = token.name
    } else {
      target = verb.positional[position]
      if (target === undefined) {
        throw new Error(token.looksNamed === undefined
          ? `line ${line}: \`${command}\` takes at most ${verb.positional.length} positional argument(s); the extra one is \`${token.value}\``
          : `line ${line}: \`${command}\` has no parameter \`${token.looksNamed}\`; available: ${Object.keys(parameters).join(', ')}`)
      }
      position += 1
    }
    if (bound.has(target)) throw new Error(`line ${line}: parameter \`${target}\` was given twice`)
    bound.set(target, token.value)
  }

  for (const [parameter, spec] of Object.entries(parameters)) {
    if (spec.required && !bound.has(parameter)) {
      throw new Error(`line ${line}: \`${command}\` is missing required parameter \`${parameter}\``)
    }
  }

  const args: Record<string, unknown> = {}
  for (const [parameter, raw] of bound) args[parameter] = coerce(raw, parameters[parameter], line, parameter)
  return args
}

/** Parse one line; a blank or comment-only line yields `undefined`. */
function parseStep(line: string, number: number, context: ScriptParseContext): ScriptStep | undefined {
  const body = stripComment(line).trim()
  if (body === '') return undefined

  const separator = body.search(/[ \t]/)
  const verb = separator < 0 ? body : body.slice(0, separator)
  const rest = separator < 0 ? '' : body.slice(separator + 1)
  const spec = context.verbs[verb]
  if (spec === undefined) {
    throw new Error(`line ${number}: unknown action \`${verb}\`; available: ${Object.keys(context.verbs).join(', ')}`)
  }
  const parameters = context.parametersOf(spec.tool)
  if (parameters === undefined) {
    throw new Error(`line ${number}: \`${verb}\` is not available — the capability that provides it is not enabled, or this action has no implementation on this host`)
  }
  let tokens: Token[]
  try {
    tokens = tokenize(rest, new Set(Object.keys(parameters)))
  } catch (error: unknown) {
    throw new Error(`line ${number}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    line: number,
    source: body,
    verb,
    tool: spec.tool,
    args: bindArguments(spec, tokens, parameters, number, verb),
  }
}

/**
 * Parse a whole script.
 *
 * It returns only once every line has parsed, which is what lets the caller
 * promise that a syntax error keeps the earlier lines off the user's desktop.
 *
 * @param source - the script text as the model wrote it.
 * @param context - the action table plus the target-parameter lookup.
 * @returns the actions, in line order.
 * @throws when a line has a syntax problem, or the script has no action at all.
 */
export function parseScript(source: string, context: ScriptParseContext): readonly ScriptStep[] {
  if (Object.keys(context.verbs).length === 0) {
    throw new Error('no actions are available: no capability currently exposes actions through this tool')
  }
  const steps: ScriptStep[] = []
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const step = parseStep(lines[index] ?? '', index + 1, context)
    if (step !== undefined) steps.push(step)
  }
  if (steps.length === 0) {
    throw new Error('the script has no actions: one action per line, e.g. the first verb from the prompt section that documents them')
  }
  return steps
}

/**
 * The structured output of one script call.
 *
 * One entry per action: its line, verb, whether it failed, and the action's
 * MODEL-VISIBLE content — declared `{ type: 'json' }` because those blocks are
 * isomorphic to `ContentBlock` (the action's result envelope, carrying an image
 * attachment reference for a screenshot). `render` hands them back unchanged, so
 * what the model reads is each action's own receipt.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    steps: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'integer', required: true },
          verb: { type: 'string', required: true },
          isError: { type: 'boolean', required: true },
          content: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
    },
    failedAt: { type: 'integer' },
  },
} as const

/** The output value, inferred from {@link OUTPUT_SCHEMA} — no second JSON value type. */
type ScriptOutput = InferValue<typeof OUTPUT_SCHEMA>

/** The model-visible content one action carries into the output. */
type ScriptStepContent = ScriptOutput['steps'][number]['content']

/** One action's result, as the tool's structured output. */
interface ScriptStepResult {
  readonly line: number
  readonly verb: string
  readonly isError: boolean
  readonly content: ScriptStepContent
}

/**
 * Build the `script` definition.
 *
 * Dispatch goes through `registry.execute` with a `parent` token, which makes
 * every line a NESTED dispatch rather than a model-direct call: that is why it
 * neither suffers PTC mode's collapse nor needs its own schema in the request.
 *
 * @param registry - the owning registry; sub-calls dispatch through it and the
 *   action table is read from it at execution time.
 * @returns the registry-ready definition.
 */
export function createScriptTool(registry: ToolRuntime): ToolDefinition {
  return defineTool({
    name: SCRIPT_TOOL_NAME,
    // Deliberately short: which actions exist and how they are written is the
    // enabled capability's business, and that material is appended to the prompt
    // by the capability. Anything capability-specific here would be dead weight
    // for every other capability that contributes verbs.
    description: 'Run a script: one action per line, executed in order, stopping at the first '
      + 'line that fails. The actions you may write, and how their arguments are spelled, are the '
      + 'ones listed in the prompt section of whichever capability is enabled — do not guess others. '
      + 'An action reported as unavailable means its capability is not enabled yet: do not rewrite '
      + 'the line, tell the user instead.',
    parameters: {
      code: { type: 'string', required: true, description: 'The script: one action per line.' },
      description: { type: 'string', description: 'One line saying what this script is meant to achieve, shown to the user.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const blocks: ContentBlock[] = []
        for (const step of value.steps) blocks.push(...step.content as unknown as ContentBlock[])
        blocks.push({
          type: 'text',
          text: value.failedAt === undefined
            ? `Script finished: all ${value.steps.length} action(s) took effect.`
            : `The script failed at line ${value.failedAt} and stopped; the actions before it took effect.`,
        })
        return blocks
      },
    },
    async execute(args, exec: ToolRunContext) {
      const surface = registry.scriptSurface()
      const steps = parseScript(args.code, {
        verbs: surface.verbs,
        parametersOf: (tool) => {
          const declared = registry.get(tool, exec.agent)?.parameters
          return declared === undefined ? undefined : readScriptParameters(declared)
        },
      })

      const results: ScriptStepResult[] = []
      let failedAt: number | undefined
      const agent = exec.agent
      for (const step of steps) {
        // The sub-call id is the line number: the same action may appear several
        // times in one script, and the line is the stable identity.
        const subCallId = brandString<ToolCallId>(`${String(exec.callId)}:script:${step.line}`)
        agent?.session.append('tool/ptc-dispatch-start', {
          rootCallId: exec.rootCallId,
          parentCallId: exec.callId,
          subCallId,
          name: step.tool,
          arguments: step.args,
        })
        const result = await registry.execute({
          callId: subCallId,
          rootCallId: exec.rootCallId,
          name: step.tool,
          arguments: step.args,
          ...agent === undefined ? {} : { agent },
          parent: exec.token,
          signal: exec.signal,
        })
        agent?.session.append('tool/ptc-dispatch', {
          rootCallId: exec.rootCallId,
          parentCallId: exec.callId,
          subCallId,
          name: step.tool,
          arguments: step.args,
          isError: result.isError,
          ...result.error?.info === undefined ? {} : { error: result.error.info },
          content: result.content,
        })
        results.push({
          line: step.line,
          verb: step.verb,
          isError: result.isError,
          content: result.content as unknown as ScriptStepContent,
        })
        // A composite forwards the nested result's own upward traffic; the image
        // needs no forwarding because it already returns to the model's view with
        // this tool's result through `render`.
        for (const context of result.additionalContexts ?? []) exec.deferContext(context)
        if (result.concludesTurn) exec.concludeTurn()
        if (result.isError) {
          failedAt = step.line
          break
        }
      }
      return { steps: results, ...failedAt === undefined ? {} : { failedAt } }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.description ?? 'Script',
      kind: 'other',
      rawInput: args.code,
      content: [{ type: 'text', text: args.code }],
    }),
  })
}
