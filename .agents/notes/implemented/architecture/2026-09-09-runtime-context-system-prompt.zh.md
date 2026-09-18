# Agent Note: 运行时上下文属于系统提示词

Status: implemented

[English](2026-09-09-runtime-context-system-prompt.md) | 中文

## 问题

运行时事实（工作目录、模型、权限策略）会在会话运行中变化，且每次变化都必须到达模型。当 Agent Loop 把它们记成来自 `@deepseek-ai/dsh-system-prompt` 的 user 角色快照时，最新的策略会以一条"用户从未写过"的用户消息形式出现：客户端把策略显示成对话内容，同一份事实还可能同时出现在装配出的提示词和它身后的一张快照里。

## 决定

动态 runtime context 在 Agent Loop 组装请求时追加到 `PromptAssembly.sections`，通过请求头记录最终 system 文本，不再为每次变更写入 `@deepseek-ai/dsh-system-prompt` 的 user-role 快照。工作区翻译文件只替换 Harness 基础身份与 persona 段，技能目录等插件段仍保留。

## 备选方案

**保留 user 角色快照，只在客户端隐藏重复。** 否决：重复存在于模型请求里而不在视图里，模型仍会把策略读成用户发言。

**运行时事实只写请求头。** 否决：请求头是日志元数据、不是模型输入；模型要回答当前这一轮，就需要当前目录与策略。

**每次变化都追加第二个 `system/message` 节点。** 否决：新增 system 节点会改变 surface 并强制开启新的请求系列，普通回合从此无法继续扩展前一个请求，可缓存的公共前缀随之丢失。

## 后果

新请求的策略与技能信息位于 system 字段；旧 Session 中的历史快照保持可读取，不被迁移或删除。
