# Agent Note: 社区 MCP 管理插件进入 web bundle

Status: implemented

[English](2026-09-08-community-mcp-management-plugins.md) | 中文

## Problem

MCP 配置没有官方 UI，项目级 MCP 也没有随发布组合提供。用户必须手改 `cordis.patch.yml` 配置全局服务器，项目级发现则完全没有。

## Decision

web bundle 挂载两个社区插件：`dsh-project-mcp-manager` 读取 `<projectRoot>/.dsh/mcp.yml`，并把每个服务器按会话 cwd 作用域挂载为官方 `@deepseek-ai/dsh-mcp-client` 实例；`@huanlin/dsh-plugin-mcp-manager` 增加一个设置面板，编辑 profile MCP 行并注册 `mcp_*` 模型工具。两者都以 `dsh.bundle.patch` 包发布，因此 patch 层添加它们，bundle 的 `package.json` 承担依赖。

## Alternatives considered

- **把社区插件 fork 进 `packages/`。** 否决：仓库将接管本可作为发布包消费的代码维护，而且这些插件已经面向官方扩展点。
- **新写一个项目 MCP 包。** 否决：`dsh-project-mcp-manager` 已实现 `mcp.yml` 发现、热重载与会话作用域。

## Consequences

- `pnpm dsh --profile web --dump-config` 列出 `mcp-project` 与 `dsh-mcp-manager`。
- MCP 面板与项目管理器是普通 npm 依赖而非 vendored 源码；升级即改版本号。
- 面板暴露 `/api/mcp-manager/*` 路由与 `mcp_server_*` 工具，不想要的部署需移除这两行。
