# Agent Note: 技能目录收尾系统提示词；运行时上下文使用界面语言

Status: implemented

[English](2026-09-10-skill-catalog-order-runtime-context-locale.md) | 中文

## Decision

`skills:catalog` 获得专用的收尾段位，位于 structured-output 引导和所有标准工具段之后。这样实时技能目录紧邻 Agent Loop 追加的 `runtime:context`，同时不参与静态翻译档案的段落映射。

运行时上下文的框架文本是模型可见的用户界面语言文本，使用简体中文。清空提示也使用同一语言。录制快照已机械同步更新；不会改写已提交的历史 generation。

`deployment:error-lessons` 是实时工具错误反思段。它读取 `<dshHome>/error-reflections.md` 的截断尾部；`/correct-errors` 负责维护该文档。

## Verification

系统提示词、Agent Loop、Chat 请求检查和请求头测试通过。重建 Web 后的新会话显示 `skills:catalog` 位于静态工具段之后、`runtime:context` 之前，且运行时上下文开头为中文。
