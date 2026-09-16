# Agent Note: Plan approval starts a goal

Status: implemented

English | [中文](2026-09-07-plan-approval-goal.zh.md)

## Problem

Plan mode ended at approval: the reviewed plan became an instruction the model would carry out in ordinary mode, with no durable objective tying later turns to the plan. A user who planned a long-running effort had to manually create a goal repeating the plan, or the plan would silently decay across restarts.

## Decision

`dsh-plan-mode` accepts `goalOnApprove: true`. On review approval, before the mode switch is staged, the controller requires the goal service, requires that no unfinished goal exists, and creates a durable goal whose objective is the exact approved plan text. Failure at any step fails the `exit_plan_mode` call: plan mode stays active, no goal is created, and nothing is half-applied. A completed goal can be replaced by a new approval; an unfinished one refuses with a stable message naming the conflict. When the option is off (the default), approval behaves exactly as before.

## Alternatives considered

- **Always create a goal on approval.** Rejected: goal continuation changes turn scheduling (round caps, automatic continuation), so a deployment that never asked for it would see plan approval start background rounds; the behavior must be opt-in configuration.
- **A client-side "start goal" button on the plan review card.** Rejected: the goal must exist before the plan review's approval leaves plan mode, the creation must be durable and attributed like every goal mutation, and a UI-only path would bypass the log-only fold the goal service validates.
- **Copying the plan into the goal as guidance text rather than the objective.** Rejected: the objective is what the round driver renders to the model each round; the approved plan is the completion contract, so it is the objective.

## Consequences

- Deployments that compose `dsh-goal` and enable the flag get plan-then-goal as one reviewed gesture; sessions restart and fork with both the plan decision and the objective folded from the log.
- The goal service is an optional peer: enabling the flag without mounting it fails the approval at the earliest resolvable point with a message naming the missing service, rather than silently skipping creation.
- The exit tool's model-visible return value is unchanged; goal creation reaches the model only through the durable `goal/change` log and whatever the round driver renders.
