# Agent Note：动态上下文用作者维护的中文模板，而不是翻译覆盖层

Status: implemented

[English](2026-09-08-context-locale-chinese-templates.md) | 中文

## Problem

`completePromptFile` 替换了组装出的提示词分节，但动态上下文（`sandbox:policy`、`approval:policy`、`skill-catalog`）走独立通道，仍是英文。用中文阅读模型可见工作流的用户，依然要跟英文政策文本和未翻译的技能目录作战。

## Decision

三个上下文归属方各自增加作者维护的语言配置，而不是翻译覆盖层：`sandbox-policy.contextLocale` 与 `user-approval.contextLocale` 在作者维护的中英政策模板间选择（政策状态仍按会话插值）；`tool-skill.catalogLocale` 在英文、中文与项目级 `/translate-skills` 存档（`.dsh/skill-translations.zh.json`）的自动中文间选择（逐条目回退原文）。目录的持久 `source.entries` 记录实际发布的描述，因此翻译变化参与摘要，并追加替换目录。

## Alternatives considered

- **以英文原文为键的跨上下文翻译覆盖层。** 否决：对英文模板做字符串匹配，措辞一变就失效，且映射远离归属插件。
- **无条件消费翻译存档。** 否决：存档是可选的且可能滞后于目录；显式的 locale 让意图归部署所有。
- **把翻译纳入目录摘要。** 否决：仅刷新翻译就会重发目录并移动会话前缀，而模型可见事实并无变化。

## Consequences

- 既有会话保留已发布目录，直到后续目录或翻译变化追加替换。
- 翻译存档缺失或损坏时逐条目回退英文；目录本身保持可用。
- 使用翻译提示词、`contextLocale: zh` 与默认自动目录语言时，模型可见的系统提示词各层——分节、政策上下文、技能目录——全部为中文；仅 MCP 工具描述保持 server 自己的语言。
