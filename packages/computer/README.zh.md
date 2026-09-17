---
description: "computer 包组地图：桌面控制 seam、它的 Windows 提供方，以及按需启用的工具消费方，供浏览该组的用户与维护者阅读。"
kind: "package-group"
---

# packages/computer

[English](README.md) | 中文

## Summary

computer 组让智能体能够查看并驱动用户真实的桌面——截屏、移动与点击指针、输入、按键、滚动——但只在用户要求过的地方。它是构成同一项能力的三个包：声明"桌面控制"含义的 seam、通过纯标准库 Python 运行时实现它的 Windows 提供方，以及把它变成九个细粒度工具并按需启用的消费方。启用是按会话的，并记录在日志里，因此恢复的会话保持同一状态。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| 包 | 角色 | ctx key |
|---|---|---|
| [`computer`](computer/README.zh.md) | 声明桌面控制 seam：把屏幕几何、截屏、指针与键盘收在一个可替换接口之后 | `ctx.computer` |
| [`computer-python`](computer-python/README.zh.md) | 在 Windows 上通过纯标准库 CPython 运行时、经一行 JSON 协议实现该 seam | 提供 `ctx.computer` |
| [`tool-computer-use`](tool-computer-use/README.zh.md) | 贡献九个面向模型的工具、`/computer` 命令、触发短语与四层指导文本，按会话启用 | 注册到 `ctx.tools`（agent 作用域） |

-----

<a id="related-documentation"></a>
## Related documentation

- [电脑操作](../../docs/subsystems/computer.zh.md) —— seam 的契约、为什么启用是按需的，以及工具遵循的行为准则。
- [能力 seam](../../docs/capability-seams.zh.md) —— 为什么平台能力由 Service Definition、提供方与消费方三者构成，而不是一个工具包。
- [工具执行流水线](../../docs/tool-execution-pipeline.zh.md) —— 动作级审批应该接在哪里。
- [Session 日志](../../docs/architecture.zh.md#session-log) —— 为什么启用是一个持久事件。

-----

<a id="dev-note"></a>
## Dev Note

seam 之所以存在，是因为桌面控制异常地依赖平台、也异常地敏感：macOS 上是 `CGEvent`，Linux 上是 X11 或 Wayland，而每个平台的隐私模型都完全不同。让接口不含 Win32 词汇，是"第二个提供方是一个包、而不是一个分支"的前提。

本组刻意**不**提供"运行这段自动化脚本"式的粗工具。每个动作都是各自的 `tool/call` 与 `tool/result`，这样"模型可见即可从日志重建"的不变量保持完好，策略也能按动作粒度接入。代价是每步更多的 token；这个取舍是明知而为的，理由记录在 [`tool-computer-use`](tool-computer-use/README.zh.md)。
