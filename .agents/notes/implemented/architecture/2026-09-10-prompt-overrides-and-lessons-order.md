# Agent Note: Prompt overrides and lessons ordering

Status: implemented

English | [中文](2026-09-10-prompt-overrides-and-lessons-order.zh.md)

## Problem

Error lessons were injected before tool guidance, so a live correction could be buried under static tool prose and read as stale advice. The `/correct-errors` prompt asked for long reflections, which crowded the section it was writing into. A deployment had no way to change first-party prompt text without patching the package that registers it.

## Decision

`deployment:error-lessons` uses the dedicated post-tool placement, so live error lessons follow every tool guidance section. The `/correct-errors` subagent prompt is short Chinese prose and asks for one dated section with at most five bullets.

The optional `system-prompt-overrides` settings section lets Web replace first-party prompt sections in place, with Chinese and English text stored separately. A user-authored `mcp:intro` section is also available. Because the prompt registry reads overrides at each assembly, an edit reaches the next request of an existing conversation.

## Verification

System-prompt, settings-plugin, correct-errors, and reflection-prompt tests pass. A rebuilt Web session showed the new System prompt card, Chinese runtime-context framing, and the lessons section after tool guidance.

## Alternatives considered

**Order the lessons through prose inside the lesson text.** Rejected: what matters is the order between sections, and only the section order allocation controls it.

**Cap reflections by an estimated token budget.** Rejected: a bullet count is checkable by the prompt and by the reader; a budget depends on a token estimate the reflection writer cannot see.

**Patch the prompt providers through a deployment patch file.** Rejected: a patch file expresses wiring, not prose — a prose edit there is invisible to the settings card and is lost on the next upstream change.

## Consequences

A live correction arrives after the guidance it corrects, and the lesson section stays short enough to read. Because the registry reads overrides at each assembly, an edit reaches the next request of a running conversation: no restart, and no second copy of the text held by the client.
