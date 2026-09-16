# Agent Note: Skills catalog closes the system prompt; runtime context is locale-owned

Status: implemented

English | [中文](2026-09-10-skill-catalog-order-runtime-context-locale.zh.md)

## Decision

`skills:catalog` has the dedicated last section allocation, after structured-output guidance and every standard tool section. This keeps the live catalog adjacent to the loop-appended `runtime:context` without participating in static translated-prompt paragraph mapping.

The runtime-context framing is user-facing model prose and is written in Simplified Chinese. Clearing text uses the same locale. Recorded snapshots were updated mechanically; no logged generation is rewritten.

`deployment:error-lessons` is the live tool-error reflection section. It reads the capped tail of `<dshHome>/error-reflections.md`; `/correct-errors` maintains that document.

## Verification

System-prompt, Agent-loop, Chat request-inspection, and request-header tests pass. A rebuilt Web session shows `skills:catalog` after the static tool sections and before `runtime:context`, with the runtime-context opening in Chinese.
