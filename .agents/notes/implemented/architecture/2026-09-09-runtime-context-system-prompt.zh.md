# Agent Note: 运行时上下文属于系统提示词

Status: implemented

[English](2026-09-09-runtime-context-system-prompt.md) | 中文

## 决定

动态 runtime context 在 Agent Loop 组装请求时追加到 `PromptAssembly.sections`，通过请求头记录最终 system 文本，不再为每次变更写入 `@deepseek-ai/dsh-system-prompt` 的 user-role 快照。工作区翻译文件只替换 Harness 基础身份与 persona 段，技能目录等插件段仍保留。

## 后果

新请求的策略与技能信息位于 system 字段；旧 Session 中的历史快照保持可读取，不被迁移或删除。
