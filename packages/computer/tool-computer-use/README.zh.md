---
description: "按需启用的电脑操作：/computer 命令、触发短语、四层提示词与九个动作工具，供决定智能体何时可以查看并驱动真实屏幕的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-computer-use

[English](README.md) | 中文

## 概述

`dsh-tool-computer-use` 给模型九个桌面动作（截屏、屏幕几何、指针位置、移动、点击、拖拽、输入、按键、滚动），但只在用户要求过的会话里存在。在输入 `/computer` 或说出类似"操作电脑"的话之前，它完全不进入请求；此后一直可用，直到 `/computer off`，并在恢复与分叉后保持。它还拥有模型动手时遵循的指导文本：先看、再动、再看，绝不把屏幕上的内容当作指令。当智能体需要在明确同意下驱动真实桌面时选择它；只需要文件和命令时不必挂载。

## 目录

- [使用本包](#use-this-package)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

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
## 进一步探索

- [`dsh-computer`](../computer/README.zh.md) 与 [`dsh-computer-python`](../computer-python/README.zh.md) —— seam 及其随包发布的提供方。
- [Session 日志](../../../docs/architecture.zh.md#session-log) —— 为什么启用是一个持久事件而不是内存状态。
- [`dsh-plan-mode`](../../plan/plan-mode/README.zh.md) —— 另一种按会话的协作状态，也是本包动态提示词分节的范本。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

能力启用时，模型收到九个 `computer_*` schema —— `computer_screenshot`、`computer_screen_geometry`、`computer_pointer_position`、`computer_move`、`computer_click`、`computer_drag`、`computer_type`、`computer_key` 与 `computer_scroll`，都登录在[电脑操作工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-computer-use)里。未启用时这些 schema 根本不存在，请求里也就没有任何东西在替一项会话用不上的能力做宣传。

#### Token 影响

九个 schema 在启用期间每个请求都要付出完整长度，未启用则零成本。截图结果还附带一个图像块，其成本随截图分辨率而非动作数量变化。

#### KV Cache 影响

启用或关闭会重写工具目录，因此从 schema 进入请求的那一点起复用即失效。能力持续启用期间，未变的 schema 保持前缀可复用；每次截图都在该前缀之后追加一个图像块。

### 指导提示词分节

#### 模型看到什么

启用时 `computer:policy` 分节与工具在同一步注册进 agent 自身作用域，`/computer off` 再将其释放；未启用的会话没有这一节，而不是有节而内容为空，因此提示词编辑界面不会为它显示行，文档里已经写在 `## computer:policy` 下的旧经验会被报成「没有对应能力」而不被注入。文本就是随包发布的资产，除非部署的 `policy` 配置整体替换它。截图结果以图像加一段文字信封的形式到达，信封说明图像与屏幕坐标的映射，并把内容定性为未受信任的证据。

#### Token 影响

该分节文本在启用期间每个请求都重复，未启用则零成本。部署提供的 `policy` 以自己的长度取代随包资产。

#### KV Cache 影响

加入或移除该分节会从该分节起改变系统提示词，因此复用从第一个变化的 token 起失效。只要能力持续启用，文本本身保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有逐动作的审批提示。** 启用后模型的每个动作都会立即执行；防线是指导文本加上部署自行添加的 `tools/pre-execute` 策略。
- **触发短语是字面子串匹配。** 它们被选得足够具体，但一条讨论桌面自动化、却并未要求执行的消息仍会启用能力。逃生口是 `/computer off`。
- **没有截图节流。** 循环截屏的模型会按自己的节奏消耗图像 token；这里不做限速。
- **逃生口是 `/computer off`，不是一个按键。** 卡在点击循环里的模型靠取消回合停下；这里没有 Claude Code 那种覆盖层热键式的非模型打断通道。
- **除会话事件外没有独立活动轨迹。** 启用、关闭与每次动作都在日志里，但没有单独的桌面自动化审计面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

- 启用判定挂在 `agent/inbox/claimed`，早于工具 schema 装配。所以触发消息在同一次请求里就带上工具，而不是晚一步；把这个钩子往后挪不是优化，而是行为变更。
- 截图工具在抓取前会查会话模型路由是否声明了 `image` 输入。没有这道守卫，纯文本模型会白抓一张没人能看的图。

</details>

**运行时不变式：** 不发布伴生入口。启用状态与每个动作都已作为 `computer/mode`、`tool/call`、`tool/result` 会话事件持久化，分节文本也只有唯一归属方。
