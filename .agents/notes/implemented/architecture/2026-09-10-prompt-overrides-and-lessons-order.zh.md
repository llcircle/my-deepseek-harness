# Agent Note: 提示词覆盖与错误反思顺序

Status: implemented

English | [中文](2026-09-10-prompt-overrides-and-lessons-order.zh.md)

## Decision

`deployment:error-lessons` 使用专用工具段之后的段位，因此实时错误反思会跟随所有工具介绍之后注入。`/correct-errors` 子代理提示词改为简短中文，并要求只新增一个日期小节、最多五条要点。

可选的 `system-prompt-overrides` 设置段允许 Web 原位替换第一方提示词段，中文和英文分开存储。用户编写的 `mcp:intro` 段也可编辑。由于提示词注册表在每次组装时读取覆盖内容，修改会影响已有会话的下一次请求。

## Verification

系统提示词、设置插件、纠错命令和错误反思测试通过。重建 Web 后的新会话可以看到新的“系统提示词”卡片、中文运行时上下文开头，以及位于工具引导之后的错误反思段。
