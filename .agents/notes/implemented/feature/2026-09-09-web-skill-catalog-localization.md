# Agent Note: Web skill settings availability and localized slash catalog

Status: implemented

English | [中文](2026-09-09-web-skill-catalog-localization.zh.md)

## Decision

The Web Host keeps the `skill-filesystem` settings provider enabled even when the model-facing `tool-skill` remains preset-owned. This makes the Skill Trigger card namespace available to Settings without changing the preset catalog boundary. The session skill-list request carries the active locale; Chinese locales read only `.dsh/skill-translations.zh.json` and replace `description` and `whenToUse`, while skill bodies and English responses remain unchanged. Locale changes invalidate the client catalog cache.

## Verification

The session catalog tests cover Chinese and English responses plus missing or invalid archives. The UI settings tests confirm all six plugin cards remain registered.
