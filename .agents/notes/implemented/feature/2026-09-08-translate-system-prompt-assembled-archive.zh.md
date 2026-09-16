# Agent Note：系统提示词档案存组装结果，而不是源文件

Status: implemented

[English](2026-09-08-translate-system-prompt-assembled-archive.md) | 中文

## Problem

部署注入的系统提示词对用户不可见：用户只看到效果，看不到文本，也没有办法用其他语言阅读这份工作流，或留存某会话实际运行提示词的记录。

## Decision

`/translate-system-prompt` 通过 system-prompt 服务组装接收方 agent 的作用域提示词——与 agent loop 每一轮相同的 `assemble({ agent, scope: agent })` 调用——并把渲染后的文本交给一个后台一次性子代理，由它写出双语 markdown 档案（`## Original` 加完整的 `## <locale>` 翻译）。存档组装结果而不是从源文件重构，意味着作用域 section、per-agent 变量与插值后的值都按模型实际收到的样子被捕获。

## Alternatives considered

- **拼接已注册 section 的静态文本。** 否决：静态文本错过变量插值与 complete-section 覆盖，档案可能与模型侧提示词静默偏离。
- **运行时语言开关，让提示词以另一语言面向模型渲染。** 暂缓：那会改变模型行为，属于多语言部署设计，不属于快照命令。

## Consequences

- 档案是时间点快照；提示词变化需要重新运行命令。
- 子代理提示词一次性携带完整渲染提示词，因此超大提示词会抬高该流程的委托成本，但从不触碰主对话前缀。
- 与 `/translate-skills` 的 `promptLine` 记录一起，面向人的提示词表面现在有了覆盖目录行与提示词正文的按语言档案。
