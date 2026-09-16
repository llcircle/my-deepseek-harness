# Agent Note: Skill capture extracts turns and leaves the judgment to the child

Status: implemented

[English](2026-09-08-summarize-skill-extract-dont-judge.md) | 中文

## Problem

一段刚完成部署、迁移或调试的对话包含可复用的工作流，但捕获它意味着事后手写 SKILL.md：回忆步骤、选名字、建目录、写对 frontmatter。没有任何东西把"教会它的对话"连到"保存它的 skill"。

## Decision

`/summarize-skill` 从接收代理的会话提取最近的已提交 user/assistant 文本轮次——仅 user 来源消息、非中断 assistant 消息、仅文本块——并启动一个后台一次性子代理，附带摘录与 skill 文件契约（`<skillsDir>/<kebab-name>/SKILL.md`，frontmatter `name`/`description`）。子代理判断摘录是否真的教了工作流（不值得时回复 `no reusable workflow` 且不写文件），并通过它自己的工具路径完成文件写入。命令本身只提取和委托；它从不判断、命名或写入。

## Alternatives considered

- **在命令处理器里判断"是否值得成为 skill"。** 拒绝：处理器不运行模型工作，启发式阈值只会捕获噪音；摘录是数据，只有读过它的模型才能决定里面是否存在持久 skill。
- **在 `ctx.skills` 上做专门的 skill 编写服务。** 拒绝：注册表是面向 provider 的读/合并接缝，不是写入方；skill 文件是文件系统提供方的事实来源，子代理经普通文件系统写入保持单一写路径，目录刷新归 watcher。
- **提示主代理内联写 skill。** 拒绝：那会劫持对话、把捕获与执行混在一起，并使 skill 的成本进入当前轮次上下文而非独立处理。

## Consequences

- 一次成功对话后的一次动作，就能在被 watch 的项目根得到候选 skill，文件系统提供方自动刷新目录。
- 捕获轮次中的工具调用、图片与附件对子代理不可见；活在工具参数里的工作流需要轮次范围或更丰富的摘录支持才能干净捕获。
- 重复调用可能产生重叠 skill；去重仍是人（或未来纠错处理）的职责，与只写日志的先例一致。
