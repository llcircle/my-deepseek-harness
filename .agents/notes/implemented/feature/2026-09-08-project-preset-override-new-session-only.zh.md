# Agent Note: The project preset override is new-session-only and file-anchored

Status: implemented

[English](2026-09-08-project-preset-override-new-session-only.md) | 中文

## Problem

Preset 组合是按部署或按用户的：同一个 harness 里打开的每个项目都拿到同一套默认插件，需要自己的 MCP 服务器、skill 或 shell 工具的项目，只能靠用户每次手动切换 preset——没有任何东西把这个选择锚定到目录本身。

## Decision

会话创建时解析一个可选的项目覆盖：`<projectRoot>/.dsh/agent-preset` 的首个非空行，项目根是包含 `.git` 的最近祖先（与文件系统 skill 提供方同一规则）。覆盖只在"调用方未命名 preset 的新建会话"时生效；调用方显式命名的 preset 优先，resume 与 adopt 保持会话头已记录的 preset，覆盖指向未知 preset 时以 roster 的 `agent-preset/not-found` 让创建显式失败，而不是静默回退。

## Alternatives considered

- **boot 时解析按项目插件组合。** 拒绝：Host 在任何会话（及其 cwd）存在之前启动，且一个进程服务多个工作区，boot 时无法做按项目决定；preset 接缝已经拥有按会话组合权，覆盖应落在会话选择 preset 的点上。
- **嵌入 `cordis.patch.yml` 层。** 拒绝：patch 层是部署范围、boot 时定序，理由同上；而且静默改写任意插件行的项目文件，比从 roster 里点名一个 preset 的信任步子大得多。
- **按路径为键的 settings 命名空间。** 拒绝：那会把项目事实存在项目之外——不可版本化、队友不可见——而 `.dsh/` 里的文件能与其配置的代码一起版本化。

## Consequences

- "每个项目跑自己的工具"变成代码旁的一个提交文件：MCP 服务器、skill、shell 工具随工作区而来，clone 即得同样组合。
- 覆盖按每次创建读取，改文件只影响之后创建的会话；活会话保持其组合，resume 永不重读。
- 文件缺失或空白是正常态而非 misconfiguration；只有指向未知 preset 的文件才显式失败。
