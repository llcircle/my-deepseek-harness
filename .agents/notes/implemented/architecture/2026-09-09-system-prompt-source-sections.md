# Agent Note: Preserve system prompt source sections

Status: implemented

English | [中文](2026-09-09-system-prompt-source-sections.zh.md)

## Problem

A client can learn what the model was told, but not where it came from: the prompt is one rendered block, so a reader who is told "the system prompt changed" can only be shown the whole thing again. Splitting it on the client is guesswork — only the assembly knows which provider contributed which text, in which order, after interpolation.

## Decision

A request header records an optional `systemSections` list: the interpolated sources the prompt was assembled from, kept for source-aware client presentation. The rendered prompt text itself is not part of the header — it is derived history, surface node 0, a `system/message` event — and a prompt edit reaches the model as a new request series, so `systemSections` is display metadata that is logged and folded but excluded from header comparison. An older header without the field stays valid and renders as one legacy block.

## Alternatives considered

**Keep the whole prompt in the header and diff it on the client.** Rejected: a text diff attributes a change to lines rather than to the providers that own them, and carrying prompt text in the header puts it back into the equality that decides whether the header changed at all.

**Log one session event per section.** Rejected: dozens of small events per request for data that is read only when a reader opens the prompt, each needing a place in the surface model.

**Reconstruct the sections on the client from the section contract.** Rejected: a client bundle cannot value-import another plugin's assembly, so it would re-implement interpolation and provider ordering — a second source of truth for what the model saw.

## Consequences

A client can group a prompt by source and, on a reported change, show only the sections that moved; a header without the field degrades to the full prompt instead of to nothing. The field costs one array per logged request, and it must never re-enter header equality because the series already reports a prompt edit.
