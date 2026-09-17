# Agent Note: 提示词编辑显示当前内容；失败与经验可见

Status: implemented

[English](2026-09-10-prompt-editor-current-content-and-failure-log.md) | 中文

## Decision

提示词编辑器只列出接受文本替换的段。选中段后，它会把英文 provider 当前文本、以及存在时的工作区翻译档案中文文本，分别直接填入两个可编辑字段。已有用户覆盖优先于这些基础内容。

同一卡片读取工具/MCP 失败日志和系统级经验文档。经验可编辑并保存回 `error-reflections.md`；失败日志保持只读，作为 `/correct-errors` 的证据。

## Verification

设置控制器、系统提示词和插件设置测试通过。重建 Web 后的新会话可以看到分别预填当前文本的中文和英文编辑框、失败列表和可编辑经验卡片。
