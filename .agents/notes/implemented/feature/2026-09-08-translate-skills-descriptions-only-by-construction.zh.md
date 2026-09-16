# Agent Note: Translating skill summaries keeps bodies out by construction

Status: implemented

[English](2026-09-08-translate-skills-descriptions-only-by-construction.md) | 中文

## Problem

Skill 目录混着作者语言，读者找 skill 先要跟词汇作战。整体翻译"这些 skills"从来不是目标——正文是模型逐字执行的指令，翻译它们恰恰在引导工具调用的文本里引入语义漂移的风险——但用户没有任何办法只把面向人类的摘要按自己的语言存档。

## Decision

`/translate-skills` 用 `toSummaryEntry()` 构建子代理提示词——该投影只保留每个目录 skill 的 `name`/`description`/`whenToUse`。子代理把两个摘要字段翻译成配置的区域语言，并写一份以未翻译 skill 名为键的 JSON 存档。因为正文根本不进提示词，"只翻简介"的范围由提示词不可能包含的内容来强制，而不是由一条模型可能违背的指令。

## Alternatives considered

- **提示模型翻译简介并忽略正文。** 拒绝：规则会活在模型可能违背的散文里，且把正文送进提示词再忽略它浪费委托 token，还有把正文引用进存档的风险。
- **在 `dsh-skill` 里目录读取时翻译。** 拒绝：注册表是同步读/合并接缝；把模型调用加进去会让发现延迟与翻译耦合，且注册表契约没有区域语言维度。
- **把翻译存进 skill frontmatter。** 拒绝：frontmatter 是作者的事实来源；把机器翻译合并进去会让每次再生成变成对作者文件的 diff。

## Consequences

- 存档是以 skill 名为键的普通 JSON 文件，任何消费方（UI 叠加层、区域感知目录）无需触碰注册表即可读取。
- skill 变化后简介会漂移，直到重新运行命令；存档是快照，刻意不做同步镜像。
- 仅摘要的投影意味着多语言目录在每个区域语言下收敛为一种可预测的文件形状。
