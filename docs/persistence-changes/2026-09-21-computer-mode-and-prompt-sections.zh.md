---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-21-computer-mode-and-prompt-sections

[English](2026-09-21-computer-mode-and-prompt-sections.md) | 中文

## 概述

两个持久化类型只做新增。会话事件词表新增 `computer/mode`，以 `{ active: boolean }` 记录电脑操作能力的开关。持久化的 `request/header` 事件新增可选的 `systemSections`，即渲染后提示词分段的一份快照。没有既有值改变类型，也没有可选属性变为必需，因此会话格式版本保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-computer-mode-and-prompt-sections
baseline: false
changes:
  - root: "event:computer/mode"
    previous: null
    after: "b0ac99225dac86c22503bc7bad0b09e704e8ff00c8068895fd8418f7305fe648"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "2212c188a1c336bcb1cdbbc2523e5595e7f97d3b2369a6c7bd67bad8ed33f457"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

`computer/mode` 是新增的普通事件类型。早于它存在的记录只是不含该事件，而 `computer` 投影把缺失折叠为「未启用」，因此读取与重放旧日志的行为不变。该类型进入本构建的已知事件词表，而词表在前向方向上刻意保守：早于该事件构建的读取方会拒绝含它的事件日志，而不是静默跳过一条必需事件——这正是固定规则把「新增普通事件类型」归类为保留版本的原因。`systemSections` 是 `event:request/header` 的可选新增，既有记录可以省略它。规范化形式在列表为空时丢弃该字段，且头相等性判断刻意排除它，因此它的存在不会重写请求信封。系统提示词以派生历史（系统头节点 0，即 `system/message` 事件）的形式抵达模型，而非经由这份快照；忽略它的读取方只失去可溯源展示提示词的能力，重放不受影响。

<a id="verification"></a>
## 验证

`vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts` 通过 73 个用例，含摘要稳定性用例与覆盖真实仓库全部事件的指纹用例。`vitest run packages/core/tools packages/computer/tool-computer-use packages/preset` 通过 718 个用例，含通用脚本入口的语法与派发用例、能力侧动词表的接缝用例、以及启用／停用的集成用例。`tsx scripts/persistence-changes.ts --check` 恰好分类出这两处新增、对两者推断 `same-version`，并在本记录就位后通过。

<a id="dev-note"></a>
## 开发备注

无。
