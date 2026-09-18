# Agent Note：Web 技能设置可用性与斜杠菜单本地化

Status: implemented

[English](2026-09-09-web-skill-catalog-localization.md) | 中文

## Problem

Web Host 上两条边界撞在了一起。`tool-skill` 由 preset 掌管，因此设置 provider 可能随它一起被停用，Settings 里的 Skill Trigger 卡片就会消失——部署方明明还能用这些技能，却无法配置它们。另一条：技能列表请求不携带语言，斜杠菜单的简介因此回落到英文。

## Decision

Web Host 保持启用 `skill-filesystem` 设置 provider，即使面向模型的 `tool-skill` 仍由 preset 管理。这样 Settings 中始终能找到 Skill Trigger 卡片，同时不改变 preset 的技能目录边界。Session 技能列表请求携带当前语言；中文语言只读取 `.dsh/skill-translations.zh.json`，替换 `description` 与 `whenToUse`，不读取技能正文，英文响应保持不变。语言切换会使客户端技能目录缓存失效。

## Verification

Session 技能目录测试覆盖中文、英文、缺失归档和非法归档；UI 设置测试确认六个插件卡片仍然注册。

## Alternatives considered

**让 preset 同时掌管设置 provider。** 否决：设置属于部署配置，不属于 preset 的技能目录边界——provider 归 preset 后，部署方想配置自己仍被允许使用的技能也无从下手。

**连技能正文一起翻译，而不只翻译简介字段。** 否决：翻译后的正文是技能说明的第二份拷贝，会与技能本体漂移；菜单只需要 `description` 与 `whenToUse`。

**在客户端拿英文目录自行翻译。** 否决：客户端既没有项目档案，也没有稳定的译文查找键；而请求本身已经知道语言。

**缓存技能目录且不随语言变化失效。** 否决：切换语言后菜单会一直留着上一种语言的简介，直到重新加载。

## Consequences

无论模型侧工具归属哪个平面，Settings 都保留 Skill Trigger 卡片；斜杠菜单说会话的语言，而技能正文与英文响应保持逐字节不变。语言切换会多一次目录拉取，这是"永不展示过期译文"的代价。
