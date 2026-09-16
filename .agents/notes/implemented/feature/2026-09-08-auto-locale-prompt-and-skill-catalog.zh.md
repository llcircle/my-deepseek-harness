# Agent Note: 一次翻译即激活项目的中文提示词与目录

Status: implemented

[English](2026-09-08-auto-locale-prompt-and-skill-catalog.md) | 中文

## Problem

翻译命令已经产出项目级持久产物，但使用它们仍需要部署配置：`completePromptFile` 必须指向翻译提示词，`catalogLocale` 也必须设为 `zh`。用户运行一次命令后，仍可能在配置与重启跟上之前继续收到英文模型输入。

## Decision

翻译产物按项目自动激活。`system-prompt` 默认 `autoTranslatedPrompt: true`，并按正在组装的会话工作区解析 `translatedPromptFile`（默认 `.dsh/system-prompt.zh.prompt.md`）；`assembleContextFor` 提供该工作区。文件缺失时保持标准组装；文件存在但为空或不可读时显式失败。显式 `completePromptFile` 或其他有效 complete 段优先。`tool-skill` 默认 `catalogLocale: auto`：`.dsh/skill-translations.zh.json` 中只要有一条有效描述，就选择中文框架与已存档描述，未翻译条目逐条回退原文。目录的持久 `source.entries` 记录实际发布的描述，因此翻译变化会改变 digest，后续步骤会追加替换目录。

## Alternatives considered

- **让命令改写 profile 配置。** 拒绝：用户命令不应修改部署拥有的配置，且项目相对产物仍需要逐项目路径处理。
- **只在当前 agent 作用域注册翻译提示词。** 拒绝：同一项目恢复或新建的会话不会继承它。
- **只按原始目录描述计算 digest。** 拒绝：中文模型可见目录无法从 Session 日志重建，刷新翻译也不会重新发布变化的模型输入。

## Consequences

- `/translate-system-prompt` 成功运行一次后，该项目后续组装即可使用中文；子代理写完文件后的下一轮不需要重启进程。
- `/translate-skills` 成功运行一次后目录即可使用中文。`catalogLocale: en` 仍是显式退出项，`zh` 会在存档出现前强制中文框架。
- 翻译提示词仍是快照；插件、工具或 persona 变化后需要重新运行 `/translate-system-prompt`。
- 显式部署覆盖仍优先于项目自动选择。
