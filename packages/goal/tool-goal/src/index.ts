/**
 * Model-facing goal controls over the persisted same-session goal domain.
 *
 * Two shapes, chosen by the composition. `split` (the default) registers the
 * three Codex-shaped tools `get_goal`, `create_goal`, and `update_goal`.
 * `merged` registers one `goal` tool whose `action` names the same seven
 * operations and whose other parameters are the union of the three — five
 * fewer schema characters' worth of repeated preconditions, two fewer tool
 * entries, and a catalog a reader can take in at once. The operations
 * themselves are shared, so the two shapes cannot drift in policy; only the
 * prose that addresses the model differs.
 * @module @deepseek-ai/dsh-tool-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  completionAuthority,
  goalToolExecution,
  requireDirectHuman,
} from './authority.ts'
import { renderWrapupContext } from './wrapup.ts'

export const name = 'tool-goal'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt', 'sessionProjections']

/**
 * How this row spells the goal controls to the model. `split` keeps three
 * named tools; `merged` collapses them into one `goal` tool with an `action`
 * parameter. Two shapes rather than one because a deployment's other rows,
 * prompts, and tests address the tool names: a preset that consolidates its
 * catalog opts in, and every existing composition keeps what it names.
 */
export type GoalToolShape = 'split' | 'merged'

/** Model policy and hard lower bounds for goal-state updates. */
export interface Config {
  /** Minimum admitted goal rounds before the model may self-report `blocked`. */
  blockedAfterConsecutiveRounds?: number
  /**
   * Tool shape (default `split`). See {@link GoalToolShape}.
   */
  toolShape?: GoalToolShape
}

/** Schemastery config for the goal-tool policy. */
export const Config: z<Config> = z.object({
  blockedAfterConsecutiveRounds: z.number().step(1).min(1).default(3),
  toolShape: z.union(['split', 'merged'] as const).default('split'),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly blockedAfterConsecutiveRounds: number
  readonly shape: GoalToolShape
}

type UpdateAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

const UPDATE_ACTIONS: UpdateAction[] = ['edit', 'pause', 'resume', 'complete', 'blocked']

/** Every operation the merged shape exposes as one `action` value. */
type GoalAction = 'create' | 'get' | UpdateAction

const GOAL_ACTIONS: GoalAction[] = ['create', 'get', ...UPDATE_ACTIONS]

/** Section name carrying this shape's policy text. */
function sectionName(shape: GoalToolShape): string {
  // Two names because the localized mirror is keyed by section name: the split
  // wording names three tools the merged shape does not have, so reusing one
  // name would hand a merged session the split text in the translated locale.
  return shape === 'merged' ? 'tool:goal:merged' : 'tool:goal'
}

const CREATE_DESCRIPTION =
  'Create one persisted same-session completion goal when the current direct human request '
  + 'is a long-running objective that should continue across autonomous goal rounds. You may '
  + 'infer that intent without requiring the user to say "create a goal". Do not use this for '
  + 'trivial single-turn work. Execution rejects non-human and subagent authority.'

const GET_DESCRIPTION =
  'Read the current same-session goal, including its exact id/revision, objective, phase, completed '
  + 'continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. '
  + 'Call this before updating a goal.'

const UPDATE_DESCRIPTION =
  'Update the exact current goal revision. edit, pause, and resume require a direct '
  + 'top-level human request. During an automatic continuation of the current goal, complete '
  + 'and blocked are also allowed. blocked is rejected before the configured minimum round count; the model remains '
  + 'responsible for judging that the same condition persisted across those rounds and must explain it in blocked_reason.'

/** Canonical goal-tool output, matching the existing compact Native JSON. */
type GoalToolValue =
  | { goal: null }
  | {
    goal: {
      id: string
      revision: number
      objective: string
      phase: GoalView['phase']
      roundsStarted: number
      maxGoalRounds: number
      blockedReason?: { code: string; message: string }
    }
    activation: GoalView['activation']
  }

const GOAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'null', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            id: { type: 'string', required: true },
            revision: { type: 'integer', required: true },
            objective: { type: 'string', required: true },
            phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
            roundsStarted: { type: 'integer', required: true },
            maxGoalRounds: { type: 'integer', required: true },
            blockedReason: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
      },
    },
  ],
} as const

/**
 * Render policy guidance with its deployment-selected blocked threshold. The
 * two shapes share every sentence whose meaning does not depend on how the
 * controls are spelled, so only the fragments that name them branch.
 * @param blockedAfter - the admitted consecutive-round floor for `blocked`.
 * @param shape - which spelling this row registered.
 * @returns the section text.
 */
function guidance(blockedAfter: number, shape: GoalToolShape): string {
  const merged = shape === 'merged'
  return `Use the goal ${merged ? 'tool' : 'tools'} for one long-running completion objective in the current session. `
    + `${merged ? 'action create' : 'create_goal'} may infer goal intent from a direct human request in any `
    + 'language; do not create a goal for routine single-turn work. '
    + (merged
      ? 'Read the current goal with action get before updating it, and copy its exact goal_id and revision. '
      : 'Call get_goal before update_goal and copy its exact goal_id and revision. ')
    + 'After session resume or fork, an active goal is disarmed: when '
    + 'a human asks to continue or resume in any wording or language, use '
    + `${merged ? 'action resume' : 'update_goal action resume'} to rearm it. Mark complete only when the objective is actually achieved. Mark `
    + `blocked only after the same blocking condition persists for at least ${blockedAfter} `
    + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
    + 'or useful remaining work is not blocked.'
}

/**
 * Validate config even when apply is called directly outside Loader normalization.
 * @param config - the row config, possibly a direct-apply omission.
 * @returns the materialized policy.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError('blockedAfterConsecutiveRounds must be a positive safe integer')
  }
  const shape = config.toolShape ?? 'split'
  if (shape !== 'split' && shape !== 'merged') {
    throw new TypeError('toolShape must be "split" or "merged"')
  }
  return { blockedAfterConsecutiveRounds: blockedAfter, shape }
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

/** Build the exact compare-and-set ref from model arguments. */
function goalRef(goalId: string, revision: number): GoalRef {
  if (goalId.length === 0 || goalId !== goalId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new HarnessError(
      'goal_id must be non-empty and revision must be a positive safe integer',
      'GOAL_TOOL_INVALID_UPDATE',
    )
  }
  return { id: GoalId(goalId), revision }
}

/** Stable compact model result; activation is an observation, not replay state. */
function goalValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      },
    },
    activation: goal.activation,
  }
}

/** Reusable canonical output declaration for all three goal controls. */
const GOAL_OUTPUT = {
  schema: GOAL_VALUE_SCHEMA,
  render: (_args: unknown, value: GoalToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Generic, args-only pending presentation shared by the goal tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * The payload fields a goal operation may carry, whichever shape passes them.
 * `goal_id`/`revision` are optional here because the merged shape cannot mark
 * them required in the schema — they are required for six of seven actions,
 * not for all seven — so they are checked at execution instead.
 */
interface GoalArgs {
  readonly objective?: string
  readonly goal_id?: string
  readonly revision?: number
  readonly max_goal_rounds?: number
  readonly blocked_reason?: string
}

/** Narrow the exact compare-and-set ref out of model arguments. */
function refOf(args: GoalArgs): GoalRef {
  const goalId = args.goal_id
  const revision = args.revision
  if (typeof goalId !== 'string' || typeof revision !== 'number') {
    throw new HarnessError(
      'goal_id and revision are required and must be copied from the current goal',
      'GOAL_TOOL_INVALID_UPDATE',
    )
  }
  return goalRef(goalId, revision)
}

/** Read the current same-session goal. */
function readGoal(ctx: Context, exec: ToolRunContext): GoalToolValue {
  const execution = goalToolExecution(ctx, exec)
  return goalValue(ctx.goals.get(execution.agent))
}

/** Create the session goal under direct-human authority. */
function createGoal(
  ctx: Context,
  exec: ToolRunContext,
  objective: string,
  cap: number | undefined,
): GoalToolValue {
  const execution = goalToolExecution(ctx, exec)
  requireDirectHuman(ctx, execution)
  const goal = ctx.goals.create(execution.agent, {
    objective,
    ...cap === undefined ? {} : { maxGoalRounds: cap },
  })
  return goalValue(goal)
}

/**
 * Apply one update action to the exact current revision. Both shapes route
 * here, so the admission rules, the round floor, and the wrap-up context can
 * only have one implementation.
 * @param ctx - the plugin context.
 * @param resolved - the materialized policy carrying the round floor.
 * @param action - the update verb.
 * @param args - the model arguments (payload only; the ref is read from them).
 * @param exec - the tool run context.
 * @returns the canonical compact goal value.
 */
function updateGoal(
  ctx: Context,
  resolved: ResolvedConfig,
  action: UpdateAction,
  args: GoalArgs,
  exec: ToolRunContext,
): GoalToolValue {
  const execution = goalToolExecution(ctx, exec)
  const ref = refOf(args)
  const replacements = {
    ...hasText(args.objective) ? { objective: args.objective } : {},
    ...hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {},
  }
  if (action === 'edit') {
    requireDirectHuman(ctx, execution)
    if (hasText(args.blocked_reason)) {
      throw new HarnessError('blocked_reason is valid only with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
    }
    return goalValue(ctx.goals.edit(execution.agent, ref, replacements))
  }
  if (action === 'pause' || action === 'resume') {
    requireDirectHuman(ctx, execution)
    if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
      throw new HarnessError(
        'objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked',
        'GOAL_TOOL_INVALID_UPDATE',
      )
    }
    const current = ctx.goals.get(execution.agent)
    if (action === 'resume' && current?.id === ref.id && current.revision === ref.revision
      && current.phase === 'paused') {
      throw new HarnessError(
        'the model cannot resume a paused goal; the user must resume it',
        'GOAL_TOOL_RESUME_PAUSED',
      )
    }
    return goalValue(action === 'pause'
      ? ctx.goals.pause(execution.agent, ref)
      : ctx.goals.resume(execution.agent, ref))
  }
  const authority = completionAuthority(ctx, execution)
  if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds)) {
    throw new HarnessError(
      'objective and max_goal_rounds are valid only with action edit',
      'GOAL_TOOL_INVALID_UPDATE',
    )
  }
  if (action === 'complete' && hasText(args.blocked_reason)) {
    throw new HarnessError('blocked_reason is valid only with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
  }
  if (action === 'blocked'
    && (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0)) {
    throw new HarnessError('blocked_reason is required with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
  }
  if (action === 'blocked' && authority.kind === 'goal-round'
    && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds) {
    throw new HarnessError(
      `blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; `
      + `current round is ${authority.goal.roundsStarted}`,
      'GOAL_TOOL_BLOCK_THRESHOLD',
    )
  }
  const blockedReason = args.blocked_reason
  const goal = action === 'complete'
    ? ctx.goals.complete(execution.agent, ref)
    : ctx.goals.block(execution.agent, ref, {
      code: 'model-reported',
      message: blockedReason as string,
    })
  if (authority.kind === 'goal-round') {
    exec.deferContext(createUserMessage({
      content: action === 'complete'
        ? renderWrapupContext(goal.objective)
        : renderWrapupContext(goal.objective, blockedReason as string),
      source: {
        kind: 'plugin',
        plugin: 'tool-goal',
        form: 'notice',
        summary: boundContextSummary(`${action}: ${goal.objective}`),
      },
    }))
  }
  return goalValue(goal)
}

/** Pending-card title for one update verb. */
function actionTitle(action: UpdateAction): string {
  return `${action === 'blocked' ? 'Mark' : action.charAt(0).toUpperCase() + action.slice(1)} goal`
}

/** Pending-card detail: the most specific argument the call carried. */
function actionDetail(args: GoalArgs): unknown {
  if (hasText(args.blocked_reason)) return args.blocked_reason
  if (hasText(args.objective)) return args.objective
  if (hasRoundCap(args.max_goal_rounds)) return args.max_goal_rounds
  return args.goal_id
}

/** Model-facing summary of the merged shape's single tool. */
const MERGED_DESCRIPTION =
  'One long-running goal per session, addressed by action. action get reads it; action create ' +
  `infers and starts it. ${CREATE_DESCRIPTION} ${UPDATE_DESCRIPTION}`

/** Register the goal controls in the deployment-selected shape and their policy section. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: sectionName(resolved.shape),
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: guidance(resolved.blockedAfterConsecutiveRounds, resolved.shape),
  })

  if (resolved.shape === 'merged') {
    ctx.tools.register(defineTool({
      name: 'goal',
      description: MERGED_DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: GOAL_ACTIONS,
          description: 'create | get | edit | pause | resume | complete | blocked',
        },
        objective: {
          type: 'string',
          description: 'Objective inferred from the direct human request; required with action create, '
            + 'a replacement with action edit.',
        },
        goal_id: {
          type: 'string',
          description: 'Exact id returned by action get; required for every action except create.',
        },
        revision: {
          type: 'number',
          description: 'Exact positive revision returned by action get; required for every action except create.',
        },
        max_goal_rounds: {
          type: 'number',
          description: 'Optional positive safe-integer limit on automatic continuation rounds; '
            + 'a replacement with action edit.',
        },
        blocked_reason: {
          type: 'string',
          description: 'Concrete blocking condition; required only with action blocked.',
        },
      },
      output: GOAL_OUTPUT,
      execute(args, exec) {
        if (args.action === 'get') {
          if (hasText(args.objective) || args.goal_id !== undefined || args.revision !== undefined
            || args.max_goal_rounds !== undefined || hasText(args.blocked_reason)) {
            throw new HarnessError('action get takes no other arguments', 'GOAL_TOOL_INVALID_UPDATE')
          }
          return Promise.resolve(readGoal(ctx, exec))
        }
        if (args.action === 'create') {
          if (!hasText(args.objective)) {
            throw new HarnessError('objective is required with action create', 'GOAL_TOOL_INVALID_CREATE')
          }
          if (args.goal_id !== undefined || args.revision !== undefined || hasText(args.blocked_reason)) {
            throw new HarnessError(
              'goal_id, revision, and blocked_reason are not valid with action create',
              'GOAL_TOOL_INVALID_CREATE',
            )
          }
          return Promise.resolve(createGoal(ctx, exec, args.objective, args.max_goal_rounds))
        }
        return Promise.resolve(updateGoal(ctx, resolved, args.action, args, exec))
      },
      presentCall: args => args.action === 'get'
        ? present('Read current goal', 'read')
        : args.action === 'create'
          ? present('Create goal', 'other', args.objective)
          : present(actionTitle(args.action), 'other', actionDetail(args)),
    }))
    return
  }

  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: GET_DESCRIPTION,
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      return Promise.resolve(readGoal(ctx, exec))
    },
    presentCall: () => present('Read current goal', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'create_goal',
    description: CREATE_DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete completion objective inferred from the direct human request.',
      },
      max_goal_rounds: {
        type: 'number',
        description: 'Optional positive safe-integer limit on automatic continuation rounds.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      return Promise.resolve(createGoal(ctx, exec, args.objective, args.max_goal_rounds))
    },
    presentCall: args => present('Create goal', 'other', args.objective),
  }))

  ctx.tools.register(defineTool({
    name: 'update_goal',
    description: UPDATE_DESCRIPTION,
    parameters: {
      goal_id: { type: 'string', required: true, description: 'Exact id returned by get_goal.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_goal.' },
      action: {
        type: 'string',
        required: true,
        enum: UPDATE_ACTIONS,
        description: 'edit | pause | resume | complete | blocked',
      },
      objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
      max_goal_rounds: { type: 'number', description: 'Replacement cap; valid only with action edit.' },
      blocked_reason: {
        type: 'string',
        description: 'Concrete blocking condition; required only with action blocked.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      return Promise.resolve(updateGoal(ctx, resolved, args.action, args, exec))
    },
    presentCall: args => present(actionTitle(args.action), 'other', actionDetail(args)),
  }))
}
