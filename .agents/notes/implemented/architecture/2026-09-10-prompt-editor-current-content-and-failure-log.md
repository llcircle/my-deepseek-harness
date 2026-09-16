# Agent Note: Prompt editor shows current text; failures and lessons are visible

Status: implemented

English | [中文](2026-09-10-prompt-editor-current-content-and-failure-log.zh.md)

## Decision

The prompt editor lists only sections that accept text replacement. For a selected section, it loads the English provider text and, when present, the matching Chinese text from the workspace translation archive directly into separate editable fields. An existing user override takes precedence over that base content.

The same card reads the tool/MCP failure journal and the system-level reflection document. Reflections are editable and saved back to `error-reflections.md`; the failure journal stays read-only evidence for `/correct-errors`.

## Verification

Settings-controller, system-prompt, and plugins-settings tests pass. A rebuilt Web session shows separate Chinese and English editors prefilled with their current text, the failure list, and the editable lessons card.
