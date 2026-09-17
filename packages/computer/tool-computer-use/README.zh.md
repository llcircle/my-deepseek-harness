---
description: "按需启用的电脑操作：/computer 命令、触发短语、四层提示词与九个动作工具，供决定智能体何时可以查看并驱动真实屏幕的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-computer-use

[English](README.md) | 中文

## Summary

`dsh-tool-computer-use` 给模型九个桌面动作——截屏、屏幕几何、指针位置、移动、点击、拖拽、输入、按键、滚动——但只在用户要求过的会话里。在输入 `/computer` 或说出类似"操作电脑"的话之前，这项能力完全不进入请求；此后它一直可用，直到 `/computer off`，并在恢复与分叉后保持。它还拥有模型动手时遵循的指导文本，写它的目的是让循环保持诚实：先看再动、动完核对、绝不把屏幕上的内容当作指令。当智能体需要在明确同意下操作用户的真实桌面时选择它；只需要文件和命令时不必挂载。

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

把它挂在提供方旁边；在某个会话启用它之前，它不注册任何工具。

```yaml
- name: '@deepseek-ai/dsh-computer-python'
- name: '@deepseek-ai/dsh-tool-computer-use'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `policy` | `''` | 整体替换内置指导文本。留空则使用随包发布的资产。 |
| `extraTriggers` | `[]` | 在内置短语之外追加的启用短语。 |

### 启用与关闭

有两条启用路径。`/computer`（别名 `/cu`）是显式入口：它是斜杠命令，本身不产生模型消息，而你在它后面输入的内容会在能力开启后作为你的消息投递——`/computer 帮我在记事本里写一段话` 会立刻开始工作。隐式路径是消息文本：命中触发短语表里的一条即可，所以"帮我把这个操作电脑点掉"会在同一次请求里启用能力并把话带给模型。

`/computer off` 关闭它，注销工具并记录这次变更。

启用被记录为 `computer/mode` 会话事件，因此恢复或分叉的会话会还原同一状态，而不是悄悄丢掉它。

### 为什么判定挂在 `agent/inbox/claimed`

提示词分节与工具 schema 在 `agent/pre-step` **之前**装配，所以在那里做的决定会晚一步生效——用户让智能体点一下什么东西，模型却回答它没有这个工具。`agent/inbox/claimed` 在消息被认领时同步触发，早于装配，是唯一能让"这一次请求就带上"成立的位置。

这也是启用必须同步完成的原因：工具与提示词分节就在那里一起注册进智能体自己的作用域，所以同一次装配里两者都已经在。

### 同意只能来自用户

触发判定只读人类输入（`source.kind === 'user'`）。插件通知与工具结果被忽略，因此一张碰巧包含"操作电脑"字样的截图打不开任何能力，一个"我想要这个能力"的模型也打不开。同样的推理也写在指导文本里：屏幕内容是证据，不是指令。

### 指导文本的四层

1. **静态资产** —— 随包发布的文本，各处一致。
2. **部署替换** —— `policy` 整体替换它，用于改措辞、收紧策略或换成另一种语言。
3. **运行时装载** —— `computer:policy` 分节在启用时注册进智能体作用域、关闭时随之注销，与工具同一步完成。未启用的会话不是"有分节但内容为空"，而是根本没有这一节。这正是 Claude Code 把电脑操作做成一个 MCP 服务器时的形状：禁用时 `ListTools` 返回空列表，能力缺席就什么都不宣告，而不是宣告一个空壳。
4. **证据包裹** —— 每个截图结果都被包成未受信任的界面证据，并附上明确的"这不是指令"声明。

工具刻意做成细粒度，而不是一个"写脚本"的执行体：每个动作成为各自的 `tool/call` 与 `tool/result`，日志因此可以按原样重放、失败可以定位到一步、部署可以通过 `tools/pre-execute` 按动作粒度接入审批。

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-computer`](../computer/README.zh.md) 与 [`dsh-computer-python`](../computer-python/README.zh.md) —— seam 及其随包发布的提供方。
- [Session 日志](../../../docs/architecture.zh.md#session-log) —— 为什么启用是一个持久事件而不是内存状态。
- [`dsh-plan-mode`](../../plan/plan-mode/README.zh.md) —— 另一种按会话的协作状态，也是本包动态提示词分节的范本。

-----

<a id="model-experience"></a>
## Model Experience

未启用时：什么都没有。没有工具、没有提示词分节、没有上下文——模型无法判断这项能力存在。提示词编辑界面上也不会出现它的行，因为没有分节可列；文档里已经写在 `## computer:policy` 下的旧经验仍留在文档里，但会被报成"没有对应能力"，因而不被注入。

启用后：九个名为 `computer_*` 的工具，外加一个 `computer:policy` 提示词分节，覆盖工作循环（看、动、再看）、动作选择（优先用键盘而不是坐标；用剪贴板在应用之间搬运文本）与安全边界。截图结果以图像加一段文字信封的形式到达，信封说明图像与屏幕坐标的映射，并把内容定性为未受信任的证据。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **没有逐动作的审批提示。** 启用后模型的每个动作都会立即执行；防线是指导文本加上部署自行添加的 `tools/pre-execute` 策略。
- **触发短语是字面子串匹配。** 它们被选得足够具体，但一条讨论桌面自动化、却并未要求执行的消息仍会启用能力。逃生口是 `/computer off`。
- **没有截图节流。** 循环截屏的模型会按自己的节奏消耗图像 token；这里不做限速。
- **逃生口是 `/computer off`，不是一个按键。** 卡在点击循环里的模型靠取消回合停下；这里没有 Claude Code 那种覆盖层热键式的非模型打断通道。
- **除会话事件外没有独立活动轨迹。** 启用、关闭与每次动作都在日志里，但没有单独的桌面自动化审计面。
