# Agent Note: 技能目录属于系统提示词

Status: implemented

[English](2026-09-09-skill-catalog-system-prompt.md) | 中文

## 问题

技能目录此前在 `agent/pre-step` 期间作为合成的 `user/message` 发出。由于 Agent Loop 先组装系统提示词、之后才跑那条 waterfall，目录出现在第一条用户消息之后，并被持久化为 user 角色上下文。

## 决定

`tool-skill` 注册一个有序的 `skills:catalog` 系统提示词分段。`system-prompt/assemble` waterfall 解析调用方 agent 可见的 `skill` 工具、作用域内的技能快照与项目中文翻译档案，然后替换该分段的文本。因此目录成为每个请求系统提示词的一部分；当随包提供的 `skill` 工具被遮蔽或被限制时，它不再出现。

用户对技能的直接调用仍保持为 pre-step 的 user 角色指令消息，因为那是跟随用户明确动作的任务专属内容。只有"可用技能目录"移入系统提示词。

## 后果

目录不再产生 `skill-catalog` 用户消息会话事件或替换墓碑。其当前文本在系统提示词装配时由活动技能注册表与项目翻译档案重建。断言旧有"持久化用户消息目录"的既有测试必须改为检查装配出的系统提示词。
