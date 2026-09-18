# Agent Note: 中文翻译档案按静态系统提示词分段映射

Status: implemented

[English](2026-09-10-system-prompt-translation-dedup.md) | 中文

## Problem

项目 `.dsh/system-prompt.zh.prompt.md` 是静态系统提示词的中文翻译档案。如果运行时继续注册英文静态来源，再追加这份完整中文档案，模型和 UI 都会看到重复的中英文内容；反过来，用一段中文完整替换整套提示词又会丢掉实时技能目录。

## Decision

存在中文翻译档案时，把它按空行分段，并按顺序映射到可替换静态段的源段落。匹配到的段原位替换文本并保留原始字段名；没有对应翻译段落的源段保持不变。`skills:catalog` 与 `deployment:error-lessons` 仍是实时段，因此实时 skill 注册表、项目技能简介翻译档案和当前工具错误反思会继续更新它们。

Agent Loop 产生的 `runtime:context` 仍作为独立动态段追加，因此工作目录、当前模型和其他运行时事实不会被错误地固化到翻译档案中。

没有翻译档案时保持原有英文来源分段行为。请求头中的 `systemSections` 继续保存已插值来源，旧 Session 没有该字段时由客户端回退显示完整 system 文本。来源名称只用于 UI 分组，不会注入模型文本。

## Alternatives considered

**把整份档案注册成一个额外的中文段。** 否决：英文静态来源仍会注册，模型和 UI 都会把同一份提示词按两种语言读两遍。

**用中文档案整体替换提示词。** 否决：实时的 `skills:catalog` 与 `deployment:error-lessons` 是每请求重建的，整体替换会把它们冻结成档案当时的内容。

**把每请求的运行时事实也写进档案。** 否决：工作目录与模型每请求都变，档案跟不住，而且会静默过期。

**把被替换的段命名为 `deployment:translated-prompt:N`。** 否决：虽然能用，但丢弃了原段身份——读者无法再判断文本来自哪个提供方，且所有 UI 分组键都随语言改变。

## Consequences

翻译档案不是额外的 locale 段。更新静态提示词后需要重新生成或更新项目 `.dsh/system-prompt.zh.prompt.md`；超出源段落数的翻译段落会被忽略，避免旧档案覆盖后面的段。运行时上下文仍可单独展开查看，且不会造成静态中英文重复。

## Verification

系统提示词、Agent Loop、Chat 来源行测试通过；重新构建 Host 和 Web 后，在 `http://127.0.0.1:3080/` 新建会话并发送“你好”，UI 显示原始字段名下的中文文本、实时中文 `skills:catalog`、实时 `deployment:error-lessons` 与 `runtime:context`，没有独立编号翻译段或重复英文静态来源。
