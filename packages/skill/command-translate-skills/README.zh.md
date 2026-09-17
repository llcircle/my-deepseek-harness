---
description: "/translate-skills 命令：把 skill 简介翻译成区域语言存档（仅简介），供用母语阅读 skill 的用户与组合该流程的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-translate-skills

[English](README.md) | 中文

## 概述

Skill 简介由作者用什么语言写就是什么语言，目录里因此混着多种语言，读者在到达工作流之前先要跟词汇作战。`/translate-skills` 产出一份区域语言存档：命令从 `ctx.skills.list()` 读取每个 skill 的 `description` 与可选 `whenToUse`，启动一个后台一次性子代理——携带这些摘要与明确范围：只翻简介，不翻 skill 名，永不翻正文——由子代理把翻译写成一个 JSON 文件（默认工作区的 `.dsh/skill-translations.zh.json`，以 skill 名为键）。命令本身不运行模型工作；正文从一开始就不进提示词，"永不翻译正文"是结构性保证。`dsh-tool-skill` 会自动消费该存档，因此一次成功翻译即可让会话目录以中文渲染。

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

当用户需要按需刷新一份区域语言摘要存档——典型场景是边用中文读目录边新增或修改 skill 之后——选择它。如果期望目录每次变化都自动重翻；该流程只在被调用时运行，则不适合。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-translate-skills'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `archivePath` | `.dsh/skill-translations.zh.json` | 子代理写入的存档文件；相对子代理工作区 |
| `sharedArchivePath` | Harness home 下的 `skill-translations.zh.json` | 子代理额外写入的共享存档，让一次翻译覆盖所有工作区；空字符串关闭共享副本 |
| `targetLocale` | `zh` | 翻译目标语言的 BCP-47 标签 |
| `provider` | `spawn` | 运行翻译子代理的 subagent 提供方 |
| `childTools` | `["read", "write"]` | 子代理保留的工具；其余继承来的工具一律移除。空列表表示不动它的工具集 |
| `childOmitSections` | `["harness:identity", "deployment:persona-prefix", "deployment:error-lessons"]` | 子代理拿不到的提示词分段 |

### 运行方式

在打开了目标项目的会话里输入 `/translate-skills`。确认消息会报告以下结果：

- **目录为空** —— 成功并提示 `No skills catalogued for <cwd>; nothing to translate.`（带工作区路径）；不启动子代理。
- **翻译已启动** —— 成功并给出子代理运行 id、存档路径、skill 数量与目标语言；子代理写 JSON 后在后台结束。
- **缺少运行时** —— 显式报错并指明缺失的 skill 注册表或 subagent 运行时，而不是静默跳过。

### 档案结构

```json
{ "deploy-docs": { "description": "<translated>", "whenToUse": "<translated or omitted>", "promptLine": "- \`deploy-docs\`: <translated description>" } }
```

键一律是未翻译的 skill 名；源摘要没有 `whenToUse` 时省略该字段；`promptLine` 把系统提示词渲染的目录行翻译存档。`dsh-tool-skill` 会自动读取本存档中的 `description`，只要存在至少一条翻译，就把整个目录渲染为中文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明命令如何限定翻译任务的范围；可观察行为已完全覆盖在 [使用本包](#use-this-package)。

### 设计理念

- **只翻简介，结构性保证。** 提示词由 `toSummaryEntry()` 构建——只保留 `name`/`description`/`whenToUse`，丢弃其余一切——skill 正文没有任何路径进入提示词，"永不翻译正文"是结构而非模型可能违背的指令。
- **agent 作用域目录。** 处理器经由 agent 的 preset 挂载解析技能注册表（`presets.serviceFor(agent, 'skills')`），应用级注册表仅作测试回退——文件系统目录挂在 agent 作用域上，裸应用级注册表列不出任何东西。
- **存档是文件，不是服务。** 子代理写一份 JSON 文档；`dsh-tool-skill` 在每次目录发布时读取它，未来的 UI 表面也可按自己的节奏读取。命令本身不持有任何翻译状态。
- **用户触发。** 重新运行会整体替换存档；命令从不合并或去重。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、摘要提取、翻译提示词、`/translate-skills` 处理器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Skill 子系统参考](../../../docs/subsystems/skills.zh.md) —— 本命令读取的提供方注册表与目录。
- [Subagent 子系统参考](../../../docs/subsystems/subagent.zh.md) —— 运行翻译子代理的委托接缝。
- [Skill 分组地图](../README.zh.md) —— 同组的 skill 包。

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through 翻译子代理：命令自身的确认只面向人类，而启动的 subagent 会经由拥有其投递的委托接缝，把摘要清单作为它的用户消息接收。

#### KV Cache 影响

与主对话独立：子代理有自己的会话和自己的前缀；翻译运行不会改变主对话的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **按档案整体激活** —— 一条有效描述会把目录框架切换为中文；没有翻译的条目回退原文描述。
- **手动刷新** —— 编辑 skill 不会重翻；再次运行命令即可重建存档。
- **整文件写入** —— 子代理一次写入整个存档；并发调用按最后写入者胜出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文；明确不具权威性。开放方向：UI 语言匹配时把存档摘要覆盖到 skill 菜单的客户端读取器。

</details>
