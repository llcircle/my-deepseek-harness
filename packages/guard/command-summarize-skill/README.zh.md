---
description: "/summarize-skill 命令：把最近对话后台捕获为项目 skill 文件，供保存工作流的用户与组合该流程的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-summarize-skill

[English](README.md) | 中文

## 概述

一段刚解决问题的对话蕴含着值得保存的工作流。`/summarize-skill` 捕获它：命令提取最近的 user/assistant 文本轮次，启动一个后台子代理，其提示词携带摘录，并报告它的运行 id；该子代理通过它自己的 write 工具、沙箱与审批，把工作流写成项目 skill 文件（`<skillsDir>/<kebab-name>/SKILL.md`，默认 `.dsh/skills/`）。同一件事还会在每个压缩边界自动运行：此时由摘要取代摘录，并交给**两个**子代理问两个问题——这段工作值不值得成为新 skill，以及本段加载过的某个 skill 是不是错的。命令自身不运行模型工作。

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

当用户希望用一个动作把刚结束的对话提升为可复用 skill、且不占用主线时选择它。如果 skill 只应人工刻意的编写——该命令会捕获最近轮次教的一切，由子代理判断摘录是否值得成为 skill——则不适合。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-summarize-skill'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillsDir` | `.dsh/skills` | 子代理写入的 skill 根目录；相对子代理工作区 |
| `maxTurns` | 不限 | 交给子代理的 user/assistant 文本轮次可选上限；不设即完整对话 |
| `provider` | `spawn` | 运行总结子代理的 subagent 提供方 |
| `childTools` | `["read", "write"]` | 子代理保留的工具；其余继承来的工具一律移除。空列表表示不动它的工具集 |
| `childOmitSections` | `["harness:identity", "deployment:persona-prefix", "deployment:error-lessons"]` | 子代理拿不到的提示词分段 |
| `autoCurate` | `true` | 在顶层会话每次成功的压缩边界也运行策展子代理 |
| `curateMaxTargets` | `3` | 最多把多少个**本次加载过**的 skill 全文交给反思子代理；最近用到的优先 |
| `curateMaxListedSkills` | `30` | 创建提示词最多列出多少个自有 skill，其余作为省略项报告 |

### 运行方式

在值得保存的对话后输入 `/summarize-skill`。命令名后的输入按"可选选择器 + 指引"解析：开头的 `N` 表示只取最近 N 轮，开头的 `N-M` 表示按 1 起始的闭区间选择完整对话中的对应轮次，其余文本——或没有选择器时的全部输入——作为用户指引，子代理优先遵循指引而非通用规则。`/summarize-skill` 交付完整主线对话；`/summarize-skill 3` 只交最近三轮；`/summarize-skill 2-5 部署流程` 交付所选区间并附带该指引。确认消息会报告以下结果：

- **无对话文本** —— 报错的确认说明捕获为空；不启动子代理。
- **选择无效** —— 显式报错并指明越界或格式错误的选择器；不启动子代理。
- **总结已启动** —— 成功并给出子代理运行 id 与 skill 根目录；子代理决定 skill 名、写文件并在后台结束。
- **缺少运行时** —— 显式报错并指明缺失的 subagent 运行时或提供方，而不是静默跳过。

<a id="automatic-curation-at-compaction"></a>
### 压缩边界上的自动策展

同一件事也会自动运行，而且是在会话可以**免费**改变自己后续行为的唯一时刻：压缩边界。压缩本来就会用摘要替换对话中段、重建请求前缀，所以在那里做一次自动处理不会额外损失任何缓存复用——这正是反思与自创建只被允许发生在这一时刻、而不允许在其他时刻的原因。

在成功的 `compaction/end` 上——且仅当会话是顶层会话、已挂载 subagent 运行时与 skill 注册表、调用方 agent 仍然在册、且发现返回了完整快照——该会话最多启动**两个**子代理，职责与权限互相独立。**创建**子代理总是运行：它的提示词携带摘要与本部署自有 skill 的**完整**清单，最多写**一个新** skill，且不得碰任何既有 skill。**反思**子代理只在本段确实加载过某个自有 skill 时运行：它的提示词携带摘要与那些 skill 的**全文**，只能改写交给它的文件，且不得新建。反思先跑，创建随后拿到的是它改写之后的清单，因此反思刚打磨过的那条流程在创建眼里读作"已经覆盖"。

四条边界让这件事保持诚实：

- **只有自有 skill 可被修改。** 语料只取 `.dsh` 根（`project-dsh`、`user-dsh`）。共享根（`project-agents`、`user-agents`）与随包根都不进入，因为那些文件属于别的工具或属于包本身，而反思会改写它拿到的东西。
- **两个子代理不会互相踩。** 创建最多写一个新文件、不得改既有文件；反思只能改写交给它的文件、不得新建。同一个路径最多被其中一个碰到，所以两个任务不可能覆盖彼此的工作——而只有反思拿到了判断既有正文所必需的证据。
- **每个会话同时只有一趟策展。** 在前一趟还在跑时落地的压缩会被丢弃。这个标记覆盖两个子代理的整个生命周期，只有在整趟落地、两个都被释放之后才解除。
- **失败被隔离且不可见。** 压缩失败就不策展；缺少运行时、注册表或 agent 就不策展；发现不完整就不策展；子代理启动失败只记日志并吞掉；而加载到的 skill 全归别人时没有可反思的东西，那个子代理干脆不起。主对话永远不会被告知发生过策展，也不会有任何轮次等它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明命令如何提取轮次并委托；可观察行为已完全覆盖在 [使用本包](#use-this-package)。

### 设计理念

- **提取，不解释。** 处理器从会话读取已提交的 `user/message`（仅 user 来源）与 `assistant/message`（非中断）文本轮次并原样交给子代理；内容是否教了工作流由子代理判断，提示词告诉它不值得时回复 `no reusable workflow` 且不写任何文件。
- **文件归子代理。** 提示词写明 skill 根目录约定与 frontmatter 契约（`name:`/`description:`），子代理通过它自己的 write 工具创建 `<skillsDir>/<kebab-name>/SKILL.md`——父目录一并创建——因此沙箱与审批策略原样生效。
- **两个触发器，三套提示词。** 显式命令有自己的捕获提示词；压缩处理用两个独立的构造器问两个独立的问题，好让每个子代理拿到自己的判断所需的证据、以及另一个碰不到的权限。它们的区别在于交给子代理的内容——轮次摘录，或摘要加上自有语料——以及允许运行的时机，而后者恰恰是运行代价不同的地方（见[压缩边界上的自动策展](#automatic-curation-at-compaction)）。
- **目录自动刷新。** 文件系统 skill 提供方 watch skill 根目录，子代理的写入经由普通 watcher 路径失效目录；本命令不做任何注册表工作。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、轮次提取、捕获提示词与两套策展提示词、`/summarize-skill` 处理器、压缩监听器，以及为反思把关的"技能加载"读取器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Skill 子系统参考](../../../docs/subsystems/skills.zh.md) —— 本命令经文件系统提供方喂给的提供方注册表与目录。
- [Subagent 子系统参考](../../../docs/subsystems/subagent.zh.md) —— 运行总结子代理的委托接缝。
- [guard 分组地图](../README.zh.md) —— 同组的 guard 包。

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through 总结子代理：命令自身的确认只面向人类，而启动的 subagent 会经由拥有其投递的委托接缝，把捕获提示词作为它的用户消息接收；压缩处理启动自己的子代理，且没有任何确认。

#### KV Cache 影响

与主对话独立：子代理有自己的会话和自己的前缀，捕获运行不会改变主对话的请求前缀。压缩处理对这一点是刻意的——只在前缀本来就要重建的地方运行。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅文本轮次** —— 捕获轮次中的图片、文件与工具结果对子代理不可见；活在工具调用参数里的工作流不会出现在摘录中。自动处理读的是压缩摘要，看到的比摘录还少。
- **无名字控制** —— kebab-case skill 名由子代理选择；想要特定名字的用户事后编辑文件或 frontmatter。
- **无完成通知** —— 命令报告子代理 id 即返回，自动处理则不向任何人报告；观察子代理结束是 subagent 表面的职责，不是本命令的。
- **反思受两条规则限制** —— 只有 `.dsh` 根会被交出，而且只考虑本段确实加载过的 skill。skill 存放在共享根或随包根的部署，只能针对自己的根做创建。
- **策展是尽力而为** —— 漏掉一次压缩边界、丢弃一次并发处理、或子代理启动失败，都只意味着那一次边界没有被策展；没有任何重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open directions: a curation budget that survives across sessions (today's `inFlight` marker is per-process), and a surface that tells a user a curation ran — deliberately omitted so far, because the point of running at the compaction boundary is that the main line never notices.

</details>

**运行时不变式：** 不发布伴生入口。该命令自身不跑模型、不写任何文件；技能文件由子 agent 通过自己的写工具、沙箱与审批链路写入。
