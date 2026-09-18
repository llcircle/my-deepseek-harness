---
description: "/translate-system-prompt 命令：把接收方 agent 组装出的系统提示词存成双语档案，供用母语阅读工作流的用户与审计部署的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-translate-system-prompt

[English](README.md) | 中文

## 概述

部署注入的系统提示词只写一次，通常是英文，用户永远看不到文本本身——只看到它的效果。`/translate-system-prompt` 让它以两种语言可读：命令组装出接收方 agent 确切生效的 agent 作用域系统提示词，启动一个后台一次性子代理并携带渲染后的文本，由子代理写出两份文件：双语 markdown 档案（默认 `.dsh/system-prompt.zh.md`，内含 `## Original` 一节与完整的 `## <locale>` 翻译），以及纯翻译提示词（默认 `.dsh/system-prompt.zh.prompt.md`），后者会被 `dsh-system-prompt` 在该项目后续组装中使用。命令本身不运行模型工作。

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

当用户需要用自己的语言阅读部署注入的工作流，或维护者需要一份某会话实际运行提示词的时间点记录时，选择它。如果期望提示词每次变化都自动重新存档，则不适合：该流程只在被调用时运行，档案是快照而非实时镜像。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-commands'
- name: '@deepseek-ai/dsh-command-translate-system-prompt'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `archivePath` | `.dsh/system-prompt.zh.md` | 子代理写入的双语存档文件；相对子代理工作区 |
| `promptOnlyPath` | `.dsh/system-prompt.zh.prompt.md` | 子代理写入的纯翻译系统提示词；相对子代理工作区 |
| `targetLocale` | `zh` | 翻译目标语言的 BCP-47 标签 |
| `provider` | `spawn` | 运行翻译子代理的 subagent 提供方 |

### 运行方式

在想要存档其提示词的会话里输入 `/translate-system-prompt`。确认消息会报告以下结果：

- **提示词为空** —— 成功并提示 `The assembled system prompt is empty; nothing to translate.`；不启动子代理。
- **翻译已启动** —— 成功并给出子代理运行 id、两个输出路径与目标语言；子代理写出文件后在后台结束。
- **缺少运行时** —— 显式报错并指明缺失的 system-prompt 服务或 subagent 运行时，而不是静默跳过。
- **组装失败** —— 显式报错并指明组装故障；不启动子代理。

### 档案结构

```markdown
## Original

<the assembled system prompt, verbatim>

## zh

<the full translation into the locale>
```

`Original` 一节是组装出的系统提示词原文（逐字保留），`zh` 一节是完整翻译。

`{{variable}}` 占位符、工具名与代码按指令保持原文；其余内容整体翻译。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何限定存档任务范围；可观察行为已在 [使用本包](#use-this-package) 完整覆盖。

### 设计理念

- **存档组装结果，而不是输入源文件。** 命令渲染与 agent loop 每一轮相同的组装结果（`assemble({ agent, scope: agent })` 加 `renderPrompt`），档案与模型实际收到的内容一致——包括作用域 section 与插值后的变量——而不是从源文件重构。
- **产物是文件，不是服务。** 子代理写一份双语 markdown 档案与一份纯翻译提示词；人类和 system-prompt 插件按各自节奏读取。命令本身不持有翻译状态。
- **用户手动触发。** 重复运行会整体覆盖档案；命令从不合并或版本化。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、提示词组装与渲染、翻译提示词、`/translate-system-prompt` 处理器 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [System prompt 子系统](../../../packages/core/system-prompt/README.zh.md) —— 本命令经由其渲染的组装服务。
- [Subagent 子系统参考](../../../docs/subsystems/subagent.zh.md) —— 运行翻译子代理的委托接缝。
- [`/translate-skills`](../command-translate-skills/README.zh.md) —— 按语言存档 skill 目录简介的配套流程。

-----

<a id="model-experience"></a>
## 模型体验

经由翻译子代理间接体现：命令自身的确认消息只面向人，而启动的子代理通过拥有投递职责的委托接缝，把渲染后的提示词作为自己的用户消息接收。

#### KV Cache 影响

与主对话无关：子代理是拥有自己前缀的独立会话；翻译流程运行与否，主对话的请求前缀永不改变。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **时间点快照** —— 之后提示词变化不会更新档案；重新运行命令即可重建。
- **没有档案查看器** —— 模型会自动消费纯翻译文件，但没有 UI 界面读取双语档案；在客户端呈现它属于后续工作。
- **整文件写入** —— 子代理一次性重写档案；并发调用后写者胜。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本 Dev Note 是维护者的工作上下文；明确不具权威性。开放方向：在设置中展示双语档案提示词的客户端读取器。

</details>

**运行时不变式：** 不发布伴生入口。该命令只负责渲染当前提示词并交给子 agent；子 agent 写出的文件由 `dsh-system-prompt` 消费，组装路径归它所有。
