# Agent Note: The tool error journal observes, never intercepts

Status: implemented

[English](2026-09-08-tool-error-journal-observe-never-intercept.md) | 中文

## Problem

失败的工具调用——模型可见错误、崩溃的 MCP 服务器、内部超时——只在各自会话日志里持久。操作者排查"这个工具为什么一直失败"必须先找到对的会话，而规划中的纠错工具也没有可读的进程级、跨会话数据流。

## Decision

`dsh-tool-error-journal` 挂在提交后的 `session/event` 流上——位于工具分发路径之外——把每条失败的 `tool/result` 记录（内容块的 `isError` 或封皮的内部 `error`）追加为一行有界 JSONL，并用前一条 `tool/call` 记录配对工具名。日志是只写的：一次失败的追加只告警并包含，不重试，也绝不改变或拖延任何工具结果或会话事件。

## Alternatives considered

- **在 `tools/execute` 瀑布里内联写日志。** 拒绝：这会把文件 I/O 放进分发路径，慢或坏的落盘会拖延或破坏工具结果；提交后事件流提供同样的记录且零耦合。
- **用 session-projection 单元做落盘。** 拒绝：projection fold 是内存状态推导；文件落盘不是可 fold 的状态，projection 接缝的契约是向载体提供类型化状态，不是持久操作者文件。
- **只在 `dsh-mcp-client` 内记录。** 拒绝：核心工具同样会失败，两套落点会重复选择、截断与文件策略。

## Consequences

- 纠错工具（和操作者）得到每个进程一个 append-only 文件，回答"哪些工具调用失败过、何时、为何"，无需触碰会话存储。
- 日志是尽力而为：路径不可写会在操作者日志告警后丢条目，会话日志仍是完整记录。
- 条目有界（`maxTextChars`），名字记忆在 result 到达时删除对应 call 身份，文件与映射都不会无界增长。
