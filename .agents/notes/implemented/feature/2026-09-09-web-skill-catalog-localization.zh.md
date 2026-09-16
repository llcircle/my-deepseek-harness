# Agent Note：Web 技能设置可用性与斜杠菜单本地化

Status: implemented

[English](2026-09-09-web-skill-catalog-localization.md) | 中文

## Decision

Web Host 保持启用 `skill-filesystem` 设置 provider，即使面向模型的 `tool-skill` 仍由 preset 管理。这样 Settings 中始终能找到 Skill Trigger 卡片，同时不改变 preset 的技能目录边界。Session 技能列表请求携带当前语言；中文语言只读取 `.dsh/skill-translations.zh.json`，替换 `description` 与 `whenToUse`，不读取技能正文，英文响应保持不变。语言切换会使客户端技能目录缓存失效。

## Verification

Session 技能目录测试覆盖中文、英文、缺失归档和非法归档；UI 设置测试确认六个插件卡片仍然注册。
