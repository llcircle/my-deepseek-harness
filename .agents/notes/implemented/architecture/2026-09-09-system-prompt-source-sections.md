# Agent Note: Preserve system prompt source sections

Status: implemented

English | [中文](2026-09-09-system-prompt-source-sections.zh.md)

## Decision

Request headers retain the rendered system prompt as `system` for model replay and an optional `systemSections` metadata list for source-aware client presentation. Older headers without this metadata remain valid and render as one legacy block.
