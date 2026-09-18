---
description: "error-reflection-prompt 插件：把工具错误反思文档作为有上限的经验分节注入每个系统提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-error-reflection-prompt

[English](README.md) | 中文

## 概述

只躺在文件里的经验帮不到正在干活的任何人。本插件读取部署的工具错误反思文档——与 `/correct-errors` 维护的是同一份文件，默认 `<dshHome>/error-reflections.md`——并把它的有上限尾部作为系统提示词分节（`deployment:error-lessons`）注入，让每个 agent 都携带过去工具失败的最新综合经验。文档缺失或为空时不注入任何文本。

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

当过去的工具失败应当影响之后的每一轮时选择它——它是 `/correct-errors` 的天然搭档。如果经验必须按项目隔离、或完全不进入模型上下文，则不适合：把 `docPath` 指到命令不写的位置，或不挂载本插件。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-error-reflection-prompt'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `docPath` | Harness home 下的 `error-reflections.md` | 读取的反思文档；相对路径解析到 `$DSH_HOME` 或 `~/.dsh` 下 |
| `maxPromptChars` | `6000` | 注入提示词的文档文本尾部上限 |

文档按日期分节增长；截尾保留最新的经验，并在 `## ` 标题边界处切分，较早的经验先离开提示词、后离开文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明分节如何构建；可观察行为已在 [使用本包](#use-this-package) 完整覆盖。

### 设计理念

- **文件派生，与 skill 目录同模式。** 分节文本是每次组装时求值的 provider：读取文档、返回截尾，空结果即不产生分节。没有缓存层、没有失效协议——文件就是状态。
- **取尾部，不取全文。** 文档按追加结构组织、最新经验在末尾，截尾恰好是最新的材料；标题边界切分保证最老的入选分节保持完整。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、分节文本整形、`deployment:error-lessons` 分节注册 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`/correct-errors`](../command-correct-errors/README.zh.md) —— 维护本插件所注入反思文档的命令。
- [System prompt 子系统](../../../packages/core/system-prompt/README.zh.md) —— 本插件贡献分节的注册表。

-----

<a id="model-experience"></a>
## 模型体验

### 错误反思系统提示词

#### 模型看到什么

反思文档非空时，每次请求都携带 `deployment:error-lessons` 分节：一个固定头部，后接有上限、最新内容在末尾的文档尾部。文档缺失或为空时不贡献文本。

##### Lessons template

```markdown
Lessons from past tool failures (auto-generated reflections; newest at the end):

<capped reflection-document tail>
```

#### Token 影响

每次请求至多 `maxPromptChars` 字符的文档文本，外加固定头部行；每轮在系统提示词内计入一次。

#### KV Cache 影响

分节位于 order 100，在部署 persona 之后、策略分节之前。反思文档变化时分节文本随之变化，请求前缀在该分节处移位——对低频、运维手动触发的更新而言可以接受。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **全局，而非按项目。** 默认文档是部署级单文件；按项目的经验库需要按作用域解析 `docPath`。
- **没有新鲜度标记。** 提示词携带经验但不携带最后更新时间；添加时间戳头部属于后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文；明确不具权威性。开放方向：从会话项目根解析的按项目经验库，以及让用户一眼区分新旧经验的时间戳标记行。

</details>

**运行时不变式：** 不发布伴生入口。该分节只是对运维方文档做有界截尾后的纯投影，因此不存在可供比对的第二种观测。
