# Agent Note: Skill trigger state gains project scope and live discovery

Status: implemented

English | [中文](2026-09-08-skill-trigger-project-scope-and-live-discovery.zh.md)

## Problem

The skill-trigger card let users set the three invocation states, but it required typing every skill name by hand and had one flat, global override map. A user with many skills had no way to see what existed, and a project that wanted different states for the same skill could not express that without changing the deployment-wide section.

## Decision

`skill-filesystem`'s settings section becomes two layers: the existing `invocationOverrides` map is the global section, and a new `projects` record keyed by session workspace path holds workspace-scoped maps. The host provider resolves each lookup with the session workspace and merges the project layer over the global layer, so the same skill can be `passive` globally and `ignored` in one project. The provider is host-owned so the Settings namespace remains available to Web UI. The trigger card now seeds its rows from the live session skill catalog through the existing `remote.skills.list` and the current session list snapshot, so known skills are auto-discovered and still editable. A scope toggle selects the global or current-project map; the project map saves under the session cwd.

## Alternatives considered

- **A separate project-settings file beside `.dsh/agent-preset`.** Rejected: a second settings authority duplicates the settings provider's validation, revision, and write path for no new isolation, and it would not surface through the existing settings card.
- **Only showing skills the user has already overridden.** Rejected: that is the original card and hides the auto-discovery the request asks for.
- **Copying the model catalog instead of the user-invocable one.** Rejected: the card edits both model and user visibility, so the composer catalog (`isUserInvocable`) is the complete name set.

## Consequences

- Existing global overrides keep working unchanged; the optional `projects` map adds project scope without migrating stored data.
- Discovery is advisory: a name outside the current catalog can still be typed and saved, which keeps the card usable before a catalog loads or after a skill moves.
- The `settings.plugins` card now injects `remote.skills` and `sessions`, and its tests supply those doubles.
