# Agent Note: Skill catalogs belong to the system prompt

Status: implemented

English | [中文](2026-09-09-skill-catalog-system-prompt.zh.md)

## Problem

The skill catalog was emitted as a synthetic `user/message` during `agent/pre-step`. Because the agent loop assembles the system prompt before running that waterfall, the catalog appeared after the first user message and was persisted as user-role context.

## Decision

`tool-skill` registers an ordered `skills:catalog` system-prompt section. The `system-prompt/assemble` waterfall resolves the calling agent's visible `skill` tool, scoped skill snapshot, and project Chinese translation archive, then replaces that section's text. The catalog is therefore part of the system prompt for every request and is absent when the shipped `skill` tool is shadowed or restricted.

Direct user skill invocations remain pre-step user-role instruction messages because they are task-specific content that follows the user's explicit gesture. Only the available-skill catalog moves to the system prompt.

## Alternatives considered

**Keep the injection in `agent/pre-step` and register the section earlier.** Rejected: section text is read at assembly, which precedes that waterfall; moving only the injection point still leaves the catalog arriving as user-role context on the first step.

**Emit the catalog once at session start and cache it.** Rejected: the visible catalog depends on the calling agent's scope and on the project translation archive, both of which can change mid-session, so a cached user message would keep teaching a catalog the model can no longer call.

**Leave the injection point alone and filter the catalog out of the client view.** Rejected: a client filter fixes the appearance only — the model request would still carry the catalog as user speech.

## Consequences

The catalog no longer creates `skill-catalog` user-message session events or replacement tombstones. Its current text is reconstructed during system-prompt assembly from the active skill registry and project translation archive. Existing tests that assert the previous durable user-message catalog must be migrated to inspect the assembled system prompt.
