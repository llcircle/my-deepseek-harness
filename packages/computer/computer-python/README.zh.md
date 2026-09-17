---
description: "Python/Win32 桌面控制提供方：通过纯标准库的 CPython 运行时驱动截屏与指针/键盘输入，供在 Windows 上启用或调试桌面控制的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-computer-python

[English](README.md) | 中文

## Summary

`dsh-computer-python` 在 Windows 上实现 `ctx.computer`：用一小段纯标准库的 Python 脚本驱动真实桌面。它用 GDI 截取整个虚拟屏幕、用 `zlib` 编码 PNG，并通过 `SendInput` 发送指针与键盘输入，全部经由 `ctypes`——不需要第三方包、不需要编译器、不需要原生扩展。它和 [`dsh-tool-computer-use`](../tool-computer-use/README.zh.md) 配套发布，由后者决定模型何时可以启用它。当智能体需要操作 Windows 桌面、而你不希望分发原生二进制时选择它；在其它平台上不必挂载，它会给出诚实的原因而不是留到后面才失败。

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

把它与消费方一起挂载，由消费方把 seam 变成工具。

```yaml
- name: '@deepseek-ai/dsh-computer-python'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pythonPath` | `''` | CPython 解释器（绝对路径或 PATH 名）。留空则依次探测 `python`、`python3`、`py -3`，取第一个能完成探测调用的。 |
| `timeoutMs` | `20000` | 单次动作的超时。截图包含 PNG 编码，不要设得过小。 |

挂载时不启动任何东西。解释器探测发生在第一次真实调用（或第一次 `available()`）时，因此没有桌面的部署不会因为多挂一个插件而付出代价。探测失败的结果会被缓存：请安装 Python 后重启，不要指望后面的调用会自动重试。

### 为什么是外部 Python 进程

Node 没有内置的 Win32 绑定，而其它选择在这里都更差：原生扩展需要在用户机器上装编译器，而 Windows 也没有一个现成的命令行截图工具。`ctypes` 是 CPython 标准库的一部分，于是整个提供方就是"一个脚本加一个解释器"——平台细节留在一个文件里，macOS 或 Linux 提供方替换掉它时不必改动 seam 或工具。

本提供方**不**经由 `ctx.subprocess`。那个 seam 跟随配置好的执行世界，它可能是远程沙箱，而桌面动作必须落在用户正在看的那台机器上。

### 运行时协议

`runtime/computer_agent.py` 从 stdin 读一行 JSON 请求，向 stdout 写一行 JSON 回复。请求给出动作名（`screenshot`、`display`、`pointer`、`move`、`click`、`drag`、`type`、`key`、`scroll`）及其字段；回复是 `{ ok: true, ... }` 或 `{ ok: false, error, code }`。动作集合是白名单，参数绝不经过 shell，进程退出码始终为 0——崩溃与被拒绝的动作在调用方看来必须能区分。

UTF-8 文本输入走 `KEYEVENTF_UNICODE`，它直接投递字符码，因此中文和 emoji 都能输入，不依赖当前键盘布局。

### 坐标与 DPI

脚本启动时调用 `SetProcessDPIAware()`，因此 GDI 截屏与 `SendInput`/`SetCursorPos` 处于同一个物理像素坐标系。没有这一步，缩放显示器会向截屏报告逻辑像素、却把同一批数值当作物理输入接受——失败表现是点击落在意图距离的一半处，看起来像模型的错误而不是集成的缺陷。

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-computer`](../computer/README.zh.md) —— 本包实现的 seam，含坐标契约。
- [`dsh-tool-computer-use`](../tool-computer-use/README.zh.md) —— 决定模型何时可以动手的消费方。
- [`dsh-native-command`](../../util/native-command/README.zh.md) —— 本提供方刻意没有使用的宿主无 shell 命令边界。

-----

<a id="model-experience"></a>
## Model Experience

没有直接影响。模型看到的是消费方注册的工具；本包不贡献自己的提示词或 schema。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **仅 Windows。** 其它平台得到带原因的 `available(): false`；macOS 提供方会用 `CGEvent`/`screencapture`，Linux 提供方会用 X11 或 Wayland 抓取，都在同一个接口之后。
- **每个动作一个进程。** 简单、无状态，代价是每次调用约一百毫秒的解释器启动。常驻会话能省掉这部分，但要付出生命周期与崩溃恢复的复杂度，本包暂时不承担。
- **截图是整个虚拟屏幕。** 没有区域截取，也没有窗口定向；多显示器桌面会产生一张很宽的图。
- **不校验动作是否生效。** seam 报告的是输入已送达，不是目标应用已响应。确认结果意味着再截一次屏。
- **需要桌面会话。** Windows 服务或没有交互式桌面的 SSH 会话会报告不可用，而不是返回黑屏。
