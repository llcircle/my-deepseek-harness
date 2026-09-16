# Agent Note: Skill catalogs belong to the system prompt

Status: implemented

## Problem

The skill catalog was emitted as a synthetic `user/message` during `agent/pre-step`. Because the agent loop assembles the system prompt before running that waterfall, the catalog appeared after the first user message and was persisted as user-role context.

## Decision

`tool-skill` registers an ordered `skills:catalog` system-prompt section. The `system-prompt/assemble` waterfall resolves the calling agent's visible `skill` tool, scoped skill snapshot, and project Chinese translation archive, then replaces that section's text. The catalog is therefore part of the system prompt for every request and is absent when the shipped `skill` tool is shadowed or restricted.

Direct user skill invocations remain pre-step user-role instruction messages because they are task-specific content that follows the user's explicit gesture. Only the available-skill catalog moves to the system prompt.

## Consequences

The catalog no longer creates `skill-catalog` user-message session events or replacement tombstones. Its current text is reconstructed during system-prompt assembly from the active skill registry and project translation archive. Existing tests that assert the previous durable user-message catalog must be migrated to inspect the assembled system prompt.
