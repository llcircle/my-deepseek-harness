# Agent Note: The project preset override is new-session-only and file-anchored

Status: implemented

English | [中文](2026-09-08-project-preset-override-new-session-only.zh.md)

## Problem

Preset composition was per-deployment or per-user: every project opened in the same harness got the same default plugin set, so a project that needs its own MCP servers, skills, or shell tooling required the user to remember to switch presets by hand each time — and nothing tied that choice to the directory itself.

## Decision

Session creation resolves one optional project override: the first non-empty line of `<projectRoot>/.dsh/agent-preset`, where the project root is the nearest ancestor containing `.git` (the same rule the filesystem skill provider uses). The override applies ONLY when the caller names no preset on a NEW session; an explicit caller-named preset wins, resume and adoption keep the preset already recorded on the session header, and an override naming an unknown preset fails the creation with the roster's `agent-preset/not-found` error rather than silently falling back.

## Alternatives considered

- **Per-project plugin composition resolved at boot.** Rejected: the Host boots before any session (and its cwd) exists, and one process serves several workspaces, so a boot-time decision cannot be per-project; the preset seam already owns per-session composition, so the override belongs at the point a session chooses its preset.
- **Embedding the override in `cordis.patch.yml` layers.** Rejected: patch layers are deployment-scoped and ordered at boot for the same reason, and a project file that silently rewrites arbitrary plugin rows would be a larger trust step than naming one preset from the roster.
- **A settings namespace keyed by path.** Rejected: it would store project facts outside the project — unversioned, invisible to teammates — while a file inside `.dsh/` is versionable alongside the code it configures.

## Consequences

- "Each project runs its own tools" is now one committed file next to the code: MCP servers, skills, and shell tooling arrive with the workspace, and teammates get the same composition by cloning.
- The override is read per creation, so editing the file affects only sessions created afterwards; live sessions keep their composition, and resume never re-reads it.
- A missing or blank file is the normal case, not a misconfiguration; only a file naming an unknown preset fails loudly.
