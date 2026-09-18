# Agent Note: Runtime contexts belong to the system prompt

Status: implemented

English | [中文](2026-09-09-runtime-context-system-prompt.zh.md)

## Problem

Runtime facts — working directory, model, permission policy — change while a session runs, and every change has to reach the model. While the Agent Loop recorded them as user-role snapshots from `@deepseek-ai/dsh-system-prompt`, the newest policy arrived as a user turn the user never wrote, the client showed policy as conversation content, and the same fact could appear both in the assembled prompt and in a snapshot behind it.

## Decision

Runtime context is appended to `PromptAssembly.sections` while the Agent Loop builds a request. The final system text is recorded through the request header; changes no longer create user-role snapshots from `@deepseek-ai/dsh-system-prompt`. A workspace translation file replaces only the Harness identity and persona base sections, while plugin sections such as the skill catalog remain active.

## Alternatives considered

**Keep the user-role snapshots and hide the duplication in the client.** Rejected: the duplicate lives in the model request, not in the view, so the model would still read policy as user speech.

**Record runtime facts in the request header only.** Rejected: the header is log metadata, not model input. The model needs the current directory and policy to answer the turn it is answering.

**Emit a second `system/message` node on every change.** Rejected: a new system node changes the surface and forces a new request series, so an ordinary turn would stop extending its predecessor and lose the cacheable prefix.

## Consequences

New requests carry policy and skill information in the system field. Historical snapshots in existing Sessions remain readable and are not migrated or deleted.
