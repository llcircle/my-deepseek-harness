---
description: "桌面控制能力 seam：把截屏、指针与键盘输入收在一个可替换的提供方接口之后，供选择或替换智能体触达真实桌面的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer

[English](README.md) | 中文

## Summary

`dsh-computer` 声明 `ctx.computer`：一个用于观察并操作真实桌面的接口——读取屏幕、移动与点击指针、输入文本、按键、滚动。它不附带任何实现，也不提供面向模型的工具：提供方在某个平台上实现这个接口，消费方（随包发布的 `dsh-tool-computer-use`）把它变成工具。当部署需要桌面控制、且你希望平台细节可替换时选择它；没有任何东西触达桌面时不必挂载。

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

挂载的是提供方，而不是本包本身：本包只声明 seam。随包发布的提供方是 [`dsh-computer-python`](../computer-python/README.zh.md)，它通过纯标准库的 Python 运行时驱动 Windows；随包发布的消费方是 [`dsh-tool-computer-use`](../tool-computer-use/README.zh.md)，按需把工具暴露给模型。

<a id="the-contract"></a>

### 契约

这个 seam 里的所有坐标都处在同一个坐标系： [`ComputerDisplay`](#the-contract) 描述的虚拟屏幕物理像素。截屏与输入必须共用它，否则点击会落在模型看到的位置之外。违反这一点的提供方不只是"不准"，而是**危险**的——模型唯一的反馈回路是"先动一次，再看一眼"。

`available()` 是唯一报告而不抛错的方法：它回答这台宿主能否操作，让消费方可以正常加载、在没有桌面的地方直接隐藏工具。实现会缓存探测结果，因为这个答案的代价是一次进程启动。

预期失败携带稳定的 `ComputerErrorCode`，绝不抛出需要调用方解析文本的平台错误；`ABORTED` 与 `TIMEOUT` 和真正的动作失败分开，调用方因此能区分"用户停止了"与"这一步没成功"。

### 编写提供方

继承抽象类，把类作为插件加载（它会注册为 `ctx.computer`），并把所有平台相关决策留在类内。有两条义务容易被漏掉：

- **把取消信号转发进你启动的任何东西**，并在信号触发时终止它。seam 向调用方承诺取消能到达静止状态。
- **不要经由 `ctx.subprocess`。** 那个 seam 属于配置好的执行世界，它可能是远程沙箱；桌面动作必须发生在用户真正在看的地方。直接触达宿主正是这项能力被刻意做成"显式启用"的原因。

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-computer-python`](../computer-python/README.zh.md) —— 随包发布的 Windows 提供方。
- [`dsh-tool-computer-use`](../tool-computer-use/README.zh.md) —— 随包发布的模型侧消费方，含按需启用规则。
- [新行为应该放在哪里](../../../docs/architecture.zh.md#where-new-behavior-goes) —— 为什么面向模型的能力注册在 `ctx.tools`，而平台能力要有 seam。

-----

<a id="model-experience"></a>
## Model Experience

无。本包不贡献任何提示词、工具 schema 或上下文。模型永远不知道它存在，只会看到消费方从它派生出来的工具。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **只有 Windows，且只经由随包发布的提供方。** seam 本身与平台无关，但还没有 macOS 或 Linux 实现；在那些平台上 `available()` 会给出诚实的原因，而不是等到第一次点击才失败。
- **没有无障碍树。** 模型靠看像素定位目标。这就是"点 (640, 400)"与"点保存按钮"之间的差别，也是陌生界面上脆弱性的主要来源。
- **没有区域截图或窗口定向。** 每次截屏都是整个虚拟屏幕；多显示器下会送出一张很宽的图。
- **没有逐动作的审批接线。** 需要对破坏性点击加确认的部署应通过 `tools/pre-execute` 加；本 seam 不决定策略。
