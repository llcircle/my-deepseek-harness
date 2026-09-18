# Agent Note: Skills catalog closes the system prompt; runtime context is locale-owned

Status: implemented

English | [中文](2026-09-10-skill-catalog-order-runtime-context-locale.zh.md)

## Problem

The skill catalog had an ordinary section slot, so it sat inside the static prompt's paragraph mapping and away from the runtime facts the loop appends: the two live, per-request sections ended up separated by static prose. The runtime-context framing was hardcoded Chinese even for a deployment assembling an English prompt, so a cleared snapshot could announce its withdrawal in a different language from its own heading.

## Decision

`skills:catalog` has the dedicated last section allocation, after structured-output guidance and every standard tool section. This keeps the live catalog adjacent to the loop-appended `runtime:context` without participating in static translated-prompt paragraph mapping.

The runtime-context framing is user-facing model prose and follows the assembly locale, so a Simplified-Chinese deployment reads Chinese framing. The cleared-snapshot marker is drawn from that same locale. Recorded snapshots were updated mechanically; no logged generation is rewritten.

`deployment:error-lessons` is the live tool-error reflection section. It reads the capped tail of `<dshHome>/error-reflections.md`; `/correct-errors` maintains that document.

## Verification

System-prompt, Agent-loop, Chat request-inspection, and request-header tests pass. A rebuilt Web session shows `skills:catalog` after the static tool sections and before `runtime:context`, with the runtime-context opening in Chinese.

## Alternatives considered

**Give the catalog a normal order slot and accept the mapping.** Rejected: paragraph mapping exists for the static translated archive, and a live per-request section placed inside it makes the archive's paragraph count depend on which plugins are mounted.

**Localise the framing through the workspace translation archive.** Rejected: the section is assembled by the loop rather than registered as static text, so the archive never reaches it.

**Leave the framing and the cleared marker independent.** Rejected: the two share one model message, so a Chinese heading could introduce an English withdrawal — exactly the mismatch the locale parameter exists to prevent.

## Consequences

`skills:catalog` sits last, adjacent to the loop-appended `runtime:context`, and stays out of the static paragraph mapping. Framing and cleared marker now agree on one language taken from the assembly, so a deployment's locale cannot half-translate the snapshot.
