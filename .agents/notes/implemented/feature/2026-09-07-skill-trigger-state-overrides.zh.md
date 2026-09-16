# Agent Note: Per-skill trigger-state overrides for local skills

Status: implemented

[English](2026-09-07-skill-trigger-state-overrides.md) | 中文

## Problem

Skill 调用控制此前只有逐文件 frontmatter（`disable-model-invocation`、`user-invocable`）。部署方想把某个已发现的 skill 改为被动、限制为仅用户显式调用或完全隐藏时，只能编辑每个 skill 文件——对不拥有源文件的内置或第三方 skill 尤其不便，也无法在运行时调整。

## Decision

`@deepseek-ai/dsh-skill` 拥有这套词汇：`SkillTriggerState` 联合类型——`passive`（保留两个调用面）、`active-only`（仅限用户显式调用）、`ignored`（从所有目录隐藏）——以及 `invocationPolicyForTriggerState()`，把每个状态映射到既有的 `SkillInvocationPolicy` 两个布尔位。任何地方都没有新增过滤逻辑；状态编译为所有 consumer 已在读取的相同两位。

`@deepseek-ai/dsh-skill-filesystem` 在配置中接受 `invocationOverrides` 记录（skill 名 → 触发状态），并在发现与加载两条路径上都把它应用在 frontmatter 策略之上，因此 consumer 无论列目录还是加载正文都得到一致的最终策略。键在插件加载时校验：不是合法 skill 名的键使加载失败，而不是静默地匹配不到任何 skill。

## Alternatives considered

- **在 `SkillSummary` 上新增第三个 `triggerState` 字段。** 拒绝：consumer 要么重复状态到位的映射，要么继续读布尔位，且每个 provider（runtime、filesystem、未来的远程实现）都得为同一信息再填一个字段。
- **全局启用/禁用名单。** 拒绝：仅名字的名单无法表达中间状态，且"enabled"对模型面和用户面会静默地含义不同。
- **只在编辑器侧过滤（UI 隐藏 ignored skill）。** 拒绝：ignored skill 仍可按名加载并仍消耗发现成本；策略应落在发现发生的地方。

## Consequences

- 部署方可以从一个配置位置按 skill 控制可见性，无需改动 skill 文件；该映射覆盖 frontmatter，skill 文件仍是其默认值的唯一来源。
- `ignored` 的 skill 仍会出现在内部列表中，只是两个调用面均为 false；渲染目录的 consumer 已经跳过不可调用 skill，因此没有增加注册表层级的隐藏。未来直接遍历原始候选的 consumer 看到的是策略布尔位，必须遵守它们。
- 指向已不存在 skill 的过期覆盖不是错误；对照发现结果校验会把加载失败推迟到依赖 cwd 的时刻，而加载期契约无法表达这一点。
