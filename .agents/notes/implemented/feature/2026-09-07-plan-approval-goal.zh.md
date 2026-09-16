# Agent Note: Plan approval starts a goal

Status: implemented

[English](2026-09-07-plan-approval-goal.md) | 中文

## Problem

计划模式在批准后即结束：评审过的计划成为模型在普通模式下执行的普通指令，没有持久 objective 把后续轮次与计划绑定。计划长任务的用户只能手动创建 goal 并复述计划，否则计划会在重启后悄然失效。

## Decision

`dsh-plan-mode` 接受 `goalOnApprove: true`。评审通过后、模式切换被暂存之前，控制器要求 goal 服务已挂载、要求会话上没有未完成 goal，并以批准的计划原文为 objective 创建持久 goal。任一步失败都会使 `exit_plan_mode` 调用失败：计划模式保持激活、不创建 goal、没有任何半套用状态。已完成的 goal 可以被新批准替换；未完成的 goal 以稳定消息拒绝并指明冲突。选项关闭（默认）时，批准行为与之前完全一致。

## Alternatives considered

- **批准后总是创建 goal。** 拒绝：goal 延续会改变轮次调度（轮次上限、自动延续），未要求的部署会因批准计划而启动后台轮次；该行为必须是可选配置。
- **在计划评审卡片上加"启动 goal"按钮。** 拒绝：goal 必须在批准离开计划模式之前存在，创建必须像每次 goal 变更一样持久且可归因；纯 UI 路径会绕过 goal 服务校验的 log-only fold。
- **把计划作为指导文本而非 objective 复制进 goal。** 拒绝：objective 是 round driver 每轮渲染给模型的内容；批准的计划就是完成契约，所以它就是 objective。

## Consequences

- 挂载 `dsh-goal` 并启用该开关的部署获得"先计划后 goal"的一次评审流程；会话重启和 fork 时，计划决策与 objective 都从日志 fold 恢复。
- goal 服务是可选 peer：启用开关但未挂载服务时，批准在最早可解析点显式失败并指明缺失的服务，而不是静默跳过创建。
- exit 工具对模型可见的返回值不变；goal 创建只通过持久的 `goal/change` 日志以及 round driver 渲染的内容到达模型。
