# Agent Note: 保留系统提示词来源分段

Status: implemented

## 决定

请求头继续用 `system` 保存模型重放所需的完整系统提示词，同时用可选的 `systemSections` 元数据保存已插值的来源分段，供客户端按来源展示。没有该元数据的旧请求头保持有效，并回退为一个旧版整段。
