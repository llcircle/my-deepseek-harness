# Agent Note: Community MCP management plugins join the web bundle

Status: implemented

English | [中文](2026-09-08-community-mcp-management-plugins.zh.md)

## Problem

MCP configuration had no first-party UI, and project-level MCP was not available from the shipped composition. A user had to hand-edit `cordis.patch.yml` for global servers and had no per-project discovery at all.

## Decision

The web bundle mounts two community plugins: `dsh-project-mcp-manager` reads `<projectRoot>/.dsh/mcp.yml` and mounts each server as an official `@deepseek-ai/dsh-mcp-client` instance scoped to the session cwd, while `@huanlin/dsh-plugin-mcp-manager` adds a Settings panel that edits profile MCP rows and registers `mcp_*` model tools. Both ship as `dsh.bundle.patch` packages, so the patch layer adds their rows and the bundle `package.json` carries the dependency.

## Alternatives considered

- **Forking the community plugins into `packages/`.** Rejected: the repository would own maintenance of code it can consume as published packages, and the plugins already target the official extension points.
- **Hand-rolling a new project MCP package.** Rejected: `dsh-project-mcp-manager` already implements `mcp.yml` discovery, hot reload, and session scoping.

## Consequences

- `pnpm dsh --profile web --dump-config` lists `mcp-project` and `dsh-mcp-manager`.
- The MCP panel and project manager are ordinary npm dependencies, not vendored source; upgrading is a version bump.
- The panel exposes `/api/mcp-manager/*` routes and `mcp_server_*` tools, so deployments that do not want them must remove the two rows.
