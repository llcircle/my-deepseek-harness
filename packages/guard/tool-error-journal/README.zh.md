---
description: "失败工具调用的 JSONL 日志，供需要检查错误或执行 AI 辅助纠错的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-error-journal

[English](README.md) | 中文

## 概述

失败的工具调用会以错误结果到达模型，然后消失在会话日志里。`dsh-tool-error-journal` 改为保留一份跨会话的持久记录：它观察提交后的 session 事件流，挑选两种失败形态——原生的 `tool/result`，与 PTC 模式子调用的 `tool/ptc-dispatch`——并把每个失败追加为 JSONL 文件中的一行有界 JSON，记在真正失败的那个工具名下。它是面向操作者和纠错工具的只写状态；没有任何路径把它读回循环。当你想要一个文件回答"哪些调用失败过、何时、为何"时选择它；逐会话检查日志已足够时可以跳过。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂载在会话存储旁边即可开始记录——无需其他接线。

### 何时选择

当操作者或纠错工具需要一份跨会话、进程范围的工具失败持久记录时选择它。当会话日志是唯一消费方时可以跳过：同样的 `tool/result` 与 `tool/ptc-dispatch` 记录在那里已经持久，本日志的价值只在于单文件、跨会话的形态。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-tool-error-journal'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | Harness home 下的 `tool-error-log.jsonl` | JSONL 落盘路径；相对路径解析到 `$DSH_HOME` 或 `~/.dsh` 下 |
| `maxTextChars` | `4000` | 每条记录保存的面向模型的失败文本上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-error-journal)是每个受支持字段的穷尽式真源。

### 条目结构

每行一个 JSON 对象：

```json
{"time":"2026-09-08T00:00:00.000Z","sessionId":"…","seq":7,"name":"mcp__memorix__save","callId":"call-1","text":"Error: …"}
```

`name` 对原生调用取自配对的 `tool/call` 记录，对 PTC 模式子调用则直接取自派发记录本身——子调用没有自己的调用记录；未观察到对应调用记录的原生 result 会读作 `unknown`。`callId` 在原生下是调用标识，在 PTC 下是子调用标识。内部失败标识（例如超时）会以 `internalError` 与面向模型的文本并列携带。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明日志如何观察失败并写入；可观察行为已完全覆盖在 [使用本包](#use-this-package)。

### 设计理念

- **观察，不拦截。** 插件在提交后的事件流上注册一个 `session/event` 监听并异步追加；它不在工具分发路径上，因此不可能改变任何结果。
- **会话日志仍是权威。** 本日志是派生的尽力而为投影：一次失败的追加只记录并包含，不跨重启重试，也绝不阻塞事件源。
- **有界条目。** 失败文本按 `maxTextChars` 摘取；工具名记忆是按会话的映射，result 到达即删除对应 call 身份，不会无界增长。只有原生路径需要这张表——派发记录自带工具名。

### 失败选择与配对

`tool/call` 记录按会话存储 `callId → name`。当 `tool/result` 的唯一 tool-result 内容块携带 `isError`、或事件封皮带内部 `error` 时记录一条；条目配对已存的名字，把文本块拼接后按 `maxTextChars` 截断，并盖上事件自身的时间与序号。

PTC 模式子调用从不产生 `tool/result`——把子调用挡在消息面之外正是这次坍缩的意义所在——所以同一个观察点用同样的判据挑选 `tool/ptc-dispatch`，直接从该记录读出工具名与子调用标识。少了这一支，自己捕获失败的程序（推荐写法）什么都不会留下，未捕获的则记到 `run_code` 名下，而不是真正坏掉的那个工具。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、`session/event` 观察点、串行化追加队列 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 子系统参考](../../../docs/subsystems/session.zh.md) —— 本日志派生自的持久 `tool/result` 与 `tool/ptc-dispatch` 记录。
- [guard 分组地图](../README.zh.md) —— 同组的 guard 包与 loop-hygiene 家族。

-----

<a id="model-experience"></a>
## 模型体验

None, as 本日志只写一个面向操作者的文件，不注册任何模型读取的提示词分区、工具或会话事件。

#### KV Cache 影响

独立：日志不贡献模型可见内容，因此永远不会改变可复用的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **尽力而为，非事务性** —— 一次失败的追加（路径不可写、磁盘错误）会在操作者日志告警后丢弃该条；会话日志仍是完整记录。
- **原生的工具名依赖配对的调用记录** —— 未观察到 `tool/call` 前驱的 `tool/result` 会以 `unknown` 记录；在本日志挂载前重放进新进程的 seed 正是这种形态。PTC 模式子调用不受此限，因为它的派发记录自带名字。
- **单进程范围** —— 日志只记录挂载它的进程的会话；它不是集群级汇聚点。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: the planned correction command reads this file and hands recent entries to a background subagent that writes a reflection document.

</details>

**运行时不变式：** 不发布伴生入口。该日志是供运维方与纠错工具使用的只追加、只写状态；没有任何东西把它读回循环，因此不存在循环可见的关系。
