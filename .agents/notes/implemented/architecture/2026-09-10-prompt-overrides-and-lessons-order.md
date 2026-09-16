# Agent Note: Prompt overrides and lessons ordering

Status: implemented

English | [中文](2026-09-10-prompt-overrides-and-lessons-order.zh.md)

## Decision

`deployment:error-lessons` uses the dedicated post-tool placement, so live error lessons follow every tool guidance section. The `/correct-errors` subagent prompt is short Chinese prose and asks for one dated section with at most five bullets.

The optional `system-prompt-overrides` settings section lets Web replace first-party prompt sections in place, with Chinese and English text stored separately. A user-authored `mcp:intro` section is also available. Because the prompt registry reads overrides at each assembly, an edit reaches the next request of an existing conversation.

## Verification

System-prompt, settings-plugin, correct-errors, and reflection-prompt tests pass. A rebuilt Web session showed the new System prompt card, Chinese runtime-context framing, and the lessons section after tool guidance.
