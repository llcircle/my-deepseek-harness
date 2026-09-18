# Agent Note: 技能目录收尾系统提示词；运行时上下文使用界面语言

Status: implemented

[English](2026-09-10-skill-catalog-order-runtime-context-locale.md) | 中文

## Problem

技能目录此前占用一个普通段位，于是落进静态提示词的段落映射里，并且被静态文本与 Agent Loop 追加的运行时事实隔开：两个"每请求实时"的分段反而被静态行文分开。运行时上下文的框架文本此前硬编码为中文，即使该部署装配的是英文提示词，因此"已清空"的提示可能用与它自己的抬头不同的语言宣告撤回。

## Decision

`skills:catalog` 获得专用的收尾段位，位于 structured-output 引导和所有标准工具段之后。这样实时技能目录紧邻 Agent Loop 追加的 `runtime:context`，同时不参与静态翻译档案的段落映射。

运行时上下文的框架文本是模型可见的用户界面语言文本，跟随本次装配的语言，因此中文部署看到中文开头。清空提示取自同一语言。录制快照已机械同步更新；不会改写已提交的历史 generation。

`deployment:error-lessons` 是实时工具错误反思段。它读取 `<dshHome>/error-reflections.md` 的截断尾部；`/correct-errors` 负责维护该文档。

## Verification

系统提示词、Agent Loop、Chat 请求检查和请求头测试通过。重建 Web 后的新会话显示 `skills:catalog` 位于静态工具段之后、`runtime:context` 之前，且运行时上下文开头为中文。

## Alternatives considered

**让技能目录占普通段位并接受段落映射。** 否决：段落映射是为静态翻译档案存在的；把一个每请求实时分段放进映射里，会让档案的段落数取决于挂了哪些插件。

**用工作区翻译档案本地化框架文本。** 否决：该分段由 Agent Loop 组装、而非作为静态文本注册，翻译档案根本到不了它。

**让框架文本与清空提示各自独立。** 否决：二者共用同一条模型消息，中文抬头可能引出英文的撤回说明——正是 locale 参数要消除的那种错配。

## Consequences

`skills:catalog` 位于最后，紧邻 Agent Loop 追加的 `runtime:context`，且不参与静态段落映射。框架文本与清空提示现在取自装配语言的同一种语言，部署的语言设置不会再让快照只翻译一半。
