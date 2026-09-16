# Agent Note: Runtime contexts belong to the system prompt

Status: implemented

English | [中文](2026-09-09-runtime-context-system-prompt.zh.md)

## Decision

Runtime context is appended to `PromptAssembly.sections` while the Agent Loop builds a request. The final system text is recorded through the request header; changes no longer create user-role snapshots from `@deepseek-ai/dsh-system-prompt`. A workspace translation file replaces only the Harness identity and persona base sections, while plugin sections such as the skill catalog remain active.

## Consequence

New requests carry policy and skill information in the system field. Historical snapshots in existing Sessions remain readable and are not migrated or deleted.
