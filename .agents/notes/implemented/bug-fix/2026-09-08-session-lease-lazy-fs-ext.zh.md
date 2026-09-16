# Agent Note: The session lease loads fs-ext lazily

Status: implemented

[English](2026-09-08-session-lease-lazy-fs-ext.md) | 中文

## Problem

`lease.ts` 静态 import `fs-ext`，导致加载 JSONL 持久化后端在**每个平台**都要求原生 flock 绑定存在——包括 Windows：它的 lease 实现从不调用 flock（它经 koffi 持有命名内核信号量）。没有 fs-ext 绑定的 Windows 机器完全无法启动 harness，而其写路径根本不用这个绑定。

## Decision

`flockAsync` 现在首次使用时用动态 `import('fs-ext')` 加载。win32 分支在任何 flock 调用前返回，因此 Windows 永不加载该绑定；POSIX 路径恰在取锁处加载；worker 部署不受影响——`fs-ext` 的打包别名把动态 import 与静态 import 一样重写到 stub。

## Alternatives considered

- **平台拆分文件（`lease.posix.ts` / `lease.win32.ts`）。** 拒绝：acquire 流程是一条线性契约（mkdir → 分支 → 校验 inode → 返回）；为了移动一个 import 而把 inode 校验重试循环复制到两个文件不划算。
- **可选 peer + 模块顶层 require 守卫。** 拒绝：顶层 try/catch require 在每个平台加载时都会执行，且在那里吞掉加载错误会把真正的 POSIX 配置错误推迟成首次取锁时的运行时失败。

## Consequences

- Windows 启动不再依赖仅 POSIX 的原生绑定；没有 MSVC 的机器（`pnpm install` 后）可以运行 harness（Windows 真正需要的 koffi 仍需工具链）。
- POSIX 上缺失 fs-ext 绑定会在首次会话写入时暴露动态 import 自身的错误，语义与原先静态 import 的加载期错误一致。
