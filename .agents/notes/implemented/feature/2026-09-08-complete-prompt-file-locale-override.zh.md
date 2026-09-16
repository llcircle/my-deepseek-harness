# Agent Note：翻译后的提示词经由一个 complete 分节替换组装提示词

Status: implemented

[English](2026-09-08-complete-prompt-file-locale-override.md) | 中文

## Problem

`/translate-system-prompt` 产出的是给人读的双语档案，模型收到的仍是组装出的英文提示词。想让面向模型的工作流以中文呈现的部署，没有从"已翻译"走到"实际使用"的路径。

## Decision

`system-prompt` 新增 `completePromptFile`：指向一个 UTF-8 文件的绝对路径，构造时文件存在即注册为 complete 分节。complete 分节会恢复自身为唯一提示词分节，因此文件内容替换全部组装分节（身份、persona、工具说明），而工具 schema、上下文与变量仍正常解析。加载期语义：文件缺失即未配置（标准英文组装）；其他读取失败让插件加载失败。激活后每次组装重新读文件，文件消失会让该次请求显式报错——静默回退英文会掩盖损坏的多语言部署。`/translate-system-prompt` 现在额外写一份纯翻译文件（默认 `.dsh/system-prompt.zh.prompt.md`）作为该路径；重跑命令即刷新；默认自动选择会在后续组装中使用新内容。

## Alternatives considered

- **在每个贡献插件内置分节级 i18n 字典。** 暂缓：这些文本散布在几十个包里，翻译会碎片化为按包维护，没有单一可审阅产物。
- **组装路径内运行时重新翻译。** 否决：组装内的模型调用把请求延迟耦合到翻译，且让模型可见提示词跨重启不确定。
- **运行时文件消失时静默回退英文。** 否决：多语言部署悄悄换语言是披着成功外衣的错误配置；显式报错直接指向被删除的文件。

## Consequences

- 双语档案仍是人读记录；纯翻译文件是机器消费的一半，每次刷新整体重写。
- 翻译快照把提示词冻结在翻译时刻；部署变化（新工具、persona 变更）需要重跑翻译。
- KV Cache：文件不变时 complete 分节前缀稳定；刷新时整个系统提示词前缀移位。
