# Agent Note: Translated archive maps onto static system-prompt sections

Status: implemented

English | [中文](2026-09-10-system-prompt-translation-dedup.zh.md)

## Problem

A project `.dsh/system-prompt.zh.prompt.md` file is a translated archive of the static system prompt. Keeping the English static providers and adding that complete archive makes both the model input and the UI repeat the same content in two languages; conversely, replacing the whole prompt with one translated section would drop the live skill catalog.

## Decision

When the translated archive exists, split it into blank-line paragraphs and map those paragraphs in order onto the source paragraphs of the replaceable static sections. Replace each matched section's text in place and keep its original section name; a source section that has no translated paragraph remains unchanged. `skills:catalog` and `deployment:error-lessons` remain live sections so the live skill registry, archived skill-summary translations, and current tool-error reflections keep updating them.

Agent Loop runtime facts remain a separate dynamic `runtime:context` section, so the translated archive does not freeze the current working directory, model, or other per-request values.

Without a translated archive, preserve the existing English source sections. Request headers continue to store interpolated `systemSections`; older sessions without that field fall back to the full system text in the client. Section names are UI grouping metadata and are not injected into model text.

## Consequences

The archive is not an additional locale section. Update the project `.dsh/system-prompt.zh.prompt.md` when the static prompt changes; paragraphs beyond the source-paragraph count are ignored, so a stale archive cannot overwrite later sections. Runtime context remains separately expandable without duplicating the static prompt in Chinese and English.

## Verification

System-prompt, Agent Loop, and Chat source-row tests passed. After rebuilding Host and Web, a new session at `http://127.0.0.1:3080/` sent “你好”; the UI showed the original section names with Chinese text, the live Chinese `skills:catalog`, the live `deployment:error-lessons`, and `runtime:context` without separate translated-prompt fields or duplicate English static sources.
