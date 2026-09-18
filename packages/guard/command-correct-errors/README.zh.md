---
description: "/correct-errors 命令：把工具错误日志与既有经验融合成系统级反思文档，归档原始失败并清空日志，供选择纠错流程的用户与组合它的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-correct-errors

[English](README.md) | 中文

## 概述

日志里堆满失败记录本身解决不了问题，散落在各次运行里的经验则是丢掉的经验。`/correct-errors` 运行一次纠错：它读取工具错误日志里最近的失败调用与既有的反思文档（默认 `<dshHome>/error-reflections.md`），启动一个后台一次性子代理，指示它把两者融合后重写该文档；随后把日志原始内容归档（`<dshHome>/tool-error-log-archive.jsonl`）并清空日志。命令本身不运行模型工作，子代理的结果落在 subagent 表面，而不是你的聊天里。

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

### 何时选择

当用户需要按需发起纠错、并让反思撰写脱离主线运行时选择它。如果希望每次失败都自动纠错——那需要另一种触发器，而本包刻意只在用户要求时启动工作——则不适合。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-tool-error-journal'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-correct-errors'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `journalPath` | Harness home 下的 `tool-error-log.jsonl` | 命令读取的日志文件；相对路径解析到 `$DSH_HOME` 或 `~/.dsh` 下 |
| `archivePath` | Harness home 下的 `tool-error-log-archive.jsonl` | 只追加写的归档，每次被清空的日志内容都落到这里 |
| `reflectionDocPath` | Harness home 下的 `error-reflections.md` | 子代理重写的系统级文档；经验跨项目持久保存 |
| `provider` | `spawn` | 运行纠错子代理的 subagent 提供方 |
| `maxErrors` | `20` | 交给子代理的最大日志条数，最新在后 |
| `maxReflectionChars` | `8000` | 交给子代理的既有反思文档尾部上限 |
| `childTools` | `["read", "write"]` | 子代理保留的工具；其余继承来的工具一律移除。空列表表示不动它的工具集 |
| `childOmitSections` | `["harness:identity", "deployment:persona-prefix", "deployment:error-lessons"]` | 子代理拿不到的提示词分段 |

### 运行方式

在任何支持命令的界面输入 `/correct-errors`。确认消息会报告以下结果：

- **无错误记录** —— 成功并提示 `No tool errors recorded; nothing to correct.`；不启动子代理。
- **纠错已启动** —— 成功并给出子代理运行 id、反思文档与归档路径；日志内容已移入归档、日志已清空，子代理在后台重写反思文档。
- **缺少运行时** —— 显式报错并指明缺失的 subagent 运行时或提供方，而不是静默跳过。
- **归档失败** —— 显式报错并指明故障；子代理继续运行，日志保持原样留给下一轮。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明命令如何把日志交给子代理；可观察行为已完全覆盖在 [使用本包](#use-this-package)。

### 设计理念

- **用户触发，非自动。** 命令注册表拥有触发点；处理器每次调用只启动一个一次性子代理并立即返回。没有任何监听器会因失败而自动触发纠错。
- **模型工作归子代理，簿记归命令。** 提示词指示子代理把既有经验与新失败融合、用它自己的 write 工具重写完整反思文档。命令本身只做文件簿记——把原始日志追加进归档、清空日志——且只在子代理成功启动之后执行，启动失败永不丢日志数据。
- **日志是队列，归档是账本。** 清空日志为每轮纠错定界；只追加写的归档永远保存每一条原始失败，不完美的反思不会销毁证据。

### 提示词形态

子代理提示词携带既有经验（截尾上限）、按从旧到新列出的最新条目——每个失败一行，含时间、工具名、call id、可选内部失败标识与有界文本——并指示子代理重写完整文档，以一个新的日期分节把新失败与既有经验对照综合。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、日志读取器、反思提示词、`/correct-errors` 处理器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- 工具错误日志（`@deepseek-ai/dsh-tool-error-journal`）—— 本命令读取的 JSONL 数据流。
- [Subagent 子系统参考](../../../docs/subsystems/subagent.zh.md) —— 运行纠错子代理的委托接缝。
- [guard 分组地图](../README.zh.md) —— 同组的 guard 包。

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through 纠错子代理：命令自身的确认只面向人类，而启动的 subagent 会经由拥有其投递的委托接缝，把反思提示词作为它的用户消息接收。

#### KV Cache 影响

与主对话独立：子代理有自己的会话和自己的前缀；纠错运行不会改变主对话的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **每次调用一个子代理，无去重** —— 两次 `/correct-errors` 启动两个子代理；它们互不知晓，且都向同一文档追加。
- **日志格式耦合** —— 读取器要求每行一个 JSON `ToolErrorEntry`；被截断或手改的行会让命令以读取错误失败，而不是跳过。
- **无完成通知** —— 命令报告子代理 id 即返回；观察子代理结束是 subagent 表面的职责，不是本命令的。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open direction: an automatic trigger that starts the same reflection after a configurable number of journal entries, reusing the same prompt builder.

</details>

**运行时不变式：** 不发布伴生入口。该命令自身不跑模型、不在进程内保存状态；所有写入由子 agent 完成，日志与反思文档都是运维方拥有的文件。
