# Agent Note: Web skill settings availability and localized slash catalog

Status: implemented

English | [中文](2026-09-09-web-skill-catalog-localization.zh.md)

## Problem

Two boundaries met on the web host. The preset owns the model-facing `tool-skill`, so the settings provider could be disabled along with it and the Skill Trigger card would vanish from Settings — leaving a deployment unable to configure skills it could still use. Separately, the slash-menu descriptions came back in English because the skill-list request carried no locale.

## Decision

The Web Host keeps the `skill-filesystem` settings provider enabled even when the model-facing `tool-skill` remains preset-owned. This makes the Skill Trigger card namespace available to Settings without changing the preset catalog boundary. The session skill-list request carries the active locale; Chinese locales read only `.dsh/skill-translations.zh.json` and replace `description` and `whenToUse`, while skill bodies and English responses remain unchanged. Locale changes invalidate the client catalog cache.

## Verification

The session catalog tests cover Chinese and English responses plus missing or invalid archives. The UI settings tests confirm all six plugin cards remain registered.

## Alternatives considered

**Let the preset own the settings provider too.** Rejected: the setting is deployment configuration, not part of the preset's catalog boundary — a preset-owned provider leaves a deployment unable to configure skills it is still allowed to use.

**Translate skill bodies, not only the summary fields.** Rejected: a translated body is a second copy of the instructions that drifts from the skill, and the menu only needs `description` and `whenToUse`.

**Translate on the client from the English catalog.** Rejected: the client has neither the project archive nor a stable key to look a translation up by, while the request already knows the locale.

**Cache the catalog and skip invalidation on a locale change.** Rejected: a language switch would leave the previous language's descriptions in the menu until reload.

## Consequences

Settings keep the Skill Trigger card regardless of which plane owns the model-facing tool, and the slash menu speaks the session's language while skill bodies and English responses stay byte-identical. Locale changes cost one catalog refetch, which is the price of never showing stale translations.
