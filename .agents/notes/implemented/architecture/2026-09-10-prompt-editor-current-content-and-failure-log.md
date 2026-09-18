# Agent Note: Prompt editor shows current text; failures and lessons are visible

Status: implemented

English | [中文](2026-09-10-prompt-editor-current-content-and-failure-log.zh.md)

## Problem

The card showed the shipped default text in one field, so a deployment that had already overridden a section could not see what was actually in force, and could not tell an override apart from the default. A Chinese deployment could not see the Chinese text it was really sending. The failures and lessons behind `/correct-errors` were reachable only through the filesystem.

## Decision

The prompt editor lists only sections that accept text replacement. For a selected section, it loads the English provider text and, when present, the matching Chinese text from the workspace translation archive directly into separate editable fields. An existing user override takes precedence over that base content.

The same card reads the tool/MCP failure journal and the system-level reflection document. Reflections are editable and saved back to `error-reflections.md`; the failure journal stays read-only evidence for `/correct-errors`.

## Verification

Settings-controller, system-prompt, and plugins-settings tests pass. A rebuilt Web session shows separate Chinese and English editors prefilled with their current text, the failure list, and the editable lessons card.

## Alternatives considered

**Show the effective override only.** Rejected: a reader comparing languages needs both sides at once, and a single field makes switching languages destructive.

**Reuse the read-only prompt preview for this card.** Rejected: the journal is evidence and the lessons document is editable — a preview can accept neither write.

**Keep failures and lessons in the session transcript.** Rejected: both outlive one session, and the journal is exactly what `/correct-errors` reads back on the next run.

## Consequences

A reader sees the text the next request will carry and edits either language in place, while the failure journal stays read-only evidence and the lessons document stays editable. Listing only replaceable sections keeps the card honest: everything it shows is something an override can actually affect.
