# Agent Note: Skill 触发状态获得项目作用域与实时发现

Status: implemented

[English](2026-09-08-skill-trigger-project-scope-and-live-discovery.md) | 中文

## Problem

Skill 触发卡片支持设置三种触发状态，但需要用户手输每个 skill 名，而且只有一层全局覆盖。技能很多时用户看不到现有内容；某个项目想对同一技能使用不同状态，也无法在不改部署级配置的情况下表达。

## Decision

`skill-filesystem` 的设置分节改为两层：现有 `invocationOverrides` 是全局层，新增以会话工作区路径为键的 `projects` 记录保存工作区级映射。host provider 在每次查找时按会话工作区合并两者、项目层优先，因此同一技能可以全局 `passive`、在某个项目里 `ignored`；provider 由 host 挂载以保证 Web UI 始终能看到设置命名空间。触发卡片现在通过现有 `remote.skills.list` 与当前会话列表快照，用实时技能目录预填行，已存在的技能会自动识别且仍可编辑。范围切换选择全局或当前项目映射；项目映射按会话 cwd 保存。

## Alternatives considered

- **在 `.dsh/agent-preset` 旁另建项目设置文件。** 否决：第二个设置权威会重复设置 provider 的校验、版本与写入路径，却没有新的隔离收益，也不会经过现有设置卡片展示。
- **只展示用户已覆盖过的技能。** 否决：那是旧卡片，隐藏了本次请求要求的自动发现。
- **复制模型目录而非用户可调用目录。** 否决：卡片同时编辑模型与用户可见性，而 composer 目录（`isUserInvocable`）才是完整的名称集合。

## Consequences

- 现有全局覆盖保持不变；可选的 `projects` 映射增加项目作用域，无需迁移已存数据。
- 发现是辅助性的：仍可输入并保存当前目录之外的名称，目录加载前或技能移动后卡片依然可用。
- `settings.plugins` 卡片现在注入 `remote.skills` 与 `sessions`，其测试提供相应替身。
