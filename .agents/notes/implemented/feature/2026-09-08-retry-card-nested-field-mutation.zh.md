# Agent Note: The retry card mutates one nested field instead of the whole policy

Status: implemented

[English](2026-09-08-retry-card-nested-field-mutation.md) | 中文

## Problem

DeepSeek 适配器的模型请求重试策略在其 settings 命名空间下，但唯一的写入方是原始设置文档——改重试次数意味着手写嵌套 YAML 对象，还不能丢失或凭空捏造 backoff 与 retryable-codes 字段。

## Decision

`/settings → 插件` 的 `llm-deepseek` 卡片暂存两个字段（模式，以及 normal 模式下的重试次数），通过一次寻址到确切变更路径的命名空间 mutation 写入：已存储的 normal 策略只变更 `retryPolicy.maxRetries`；首次写入或模式切换则整体替换 `retryPolicy` 对象，由 schema 自身默认值补齐 backoff 与 retryable codes。适配器既有的 `onChange` 钩子原位重注册路由，因此提交的次数对下一次请求生效，无需重启。

## Alternatives considered

- **在模型页编辑 retryPolicy。** 拒绝：该页编辑器拥有模型目录与凭据；重试次数是拥有独立命名空间的插件配置，插件配置页本来就按命名空间配对卡片，无需页面改动。
- **用暂存表单状态整体写 retryPolicy。** 拒绝：卡片会清掉部署在其组合里存储的 `backoff` 与 `retryableCodes`——卡片刻意不显示的字段——再生成时还得重新发明它们。
- **通用"provider 高级设置"卡。** 拒绝：schema 联合类型按模式与提供方各不相同；每个提供方一张类型化卡片让校验与文案保持精确。

## Consequences

- 操作者从 Web UI 修改重试次数（或切换到不限次重试）；次数存入设置文档、跨重启保留，并高于组合默认直到清除。
- 卡片对范围诚实：不渲染的字段永不写入；空计数暂存的是一次清除，保存后回落到 schema 默认（五次）。
- 失败的保存保留草稿与失败徽标，与本节其他卡片一致。
