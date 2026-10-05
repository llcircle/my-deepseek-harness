---
description: "面向模型的 skill（技能）加载工具及其每轮 BM25 检索清单，供希望了解 agent（智能体）看到的内容或配置某次请求命中哪些 skill 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-skill

[English](README.md) | 中文

## 概述

agent（智能体）可以在会话期间发现并加载 skill（技能）。在每轮的第一个步骤，插件用 BM25 把用户自己的文本与每个模型可调用 skill 做匹配，把命中项追加到该步骤的消息里；随后 `skill` 工具可按精确名称加载任意 skill，包括清单中没有提到的那个。用户可以用 `/name` 调用某个用户可调用的 skill，把相同的指令注入该步骤。`retrievalMaxResults` 限制清单条数，`catalogDescriptionMaxLength` 限制每条描述长度，`catalogLocale` 选择框架语言。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 skill 注册表一起挂载该插件，即可让 agent 拥有每轮技能清单和 `skill` 加载工具。它需要 `ctx.agents`、`ctx.tools`、`ctx.skills` 与 `ctx.systemPrompt`。

### 何时选择

当 agent 应在会话期间发现并加载 skill 时使用它。当 skill 加载由其他消费方处理或完全不需要时，请跳过——没有它，提供方与注册表仍可工作，但不会有任何东西向模型点名 skill，也没有工具去加载它们。

### 挂载与配置

与 skill 注册表和至少一个提供方一起加载该插件。配置项限制清单宽度与单条描述长度，并选择清单语言。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- name: '@deepseek-ai/dsh-tool-skill'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `retrievalMaxResults` | `5` | 一轮清单最多可点名的 skill 数量；最小为 1 |
| `catalogDescriptionMaxLength` | `500` | 清单中渲染的规范化描述最大长度；最小为 3 |
| `catalogLocale` | `auto` | `auto` 跟随当前提示词语言；`zh` 始终使用中文框架；`en` 永不翻译 |
| `catalogTranslationsFile` | `.dsh/skill-translations.zh.json` | 项目级翻译存档；相对路径按会话工作区解析 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-skill)是每个受支持字段的穷尽式真源。

### 模型得到什么

- **每轮一份检索清单。** 在一轮的第一个步骤，当存在模型可调用 skill 且可见的正是这个 `skill` 工具时，插件用 BM25 把该步骤的直接用户文本与每个 skill 的名称和描述做匹配，取前 `retrievalMaxResults` 条追加到该步骤的消息中，成为一条 `<available_skills>` 提醒，并同时说明本会话一共持有多少个 skill。默认 `auto` 语言下，只要有一条已翻译描述，框架就会使用中文；未翻译条目回退到原始描述。
- **加载工具。** 模型以精确的 skill 名称调用 `skill`，并收到完整指令正文以及规范的 `<skill_content>` 块中的资源指引；该结果作为普通工具历史保留。该工具能解析注册表中的任意名称，因此清单从未提到的名字同样可以加载——清单自己也这样声明。
- **用户显式调用。** 直接用户输入中的 `/name` token 若指名某个用户可调用 skill，会把该 skill 的指令注入该步骤，而无需模型自行加载。
- **每轮只注入一次。** 同一轮的后续步骤复用已在上下文中的那份清单；下一轮的清单会声明自己取代更早的清单，因此掉出选择的名称无需空替换即被停用。

### 可观察的成功与失败

加载清单内或清单外的 skill 都会返回其完整指令；无论加载来自工具还是用户的显式调用，模型看到的都是同一种规范形态。无效名称会报告 `Error: invalid skill name "<name>"`，未知名称会报告该 skill 未知或已不可用，被禁用模型调用的 skill 会报告其不可用于模型调用。以下情形不会追加任何内容：该步骤没有直接用户文本、该步骤消息批次为空、注册表返回的快照不完整、不存在模型可调用 skill，或 `skill` 工具被隐藏或被同名作用域工具遮蔽。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释检索清单与调用边界如何构建；可观察行为已在[使用本包](#use-this-package)和下方模型体验章节中完整说明。

### 设计理念

两个想法支撑着本包。第一，清单是**每轮从请求重新推导**出来的，而不是一份需要维护的持久文档：打分是"用户文本 + 实时注册表"的纯函数，因此没有 digest 要比较、没有替换要发布、也没有陈旧名称要显式停用。第二，一条规范渲染服务两条加载路径——工具结果与用户显式注入——经由共享自 `dsh-skill` 的 `renderSkillContent`，因此无论加载由谁发起，模型看到的都是同一种 `<skill_content>` 形态。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具注册、检索与手势 pre-step 监听器、BM25 排名调用、渲染 |
| — | 不发布运行时不变式伴生入口；这个面向模型的适配器没有独立的生命周期流；执行关系由它调用的能力 seam 负责。 |

### 检索生命周期

在每一轮的第一个步骤，插件只在消息批次携带直接用户文本时才继续：确认它注册的那个精确 `skill` 工具仍然可见，快照调用会话的 skill 目录，并且只在快照完整时把每个模型可调用 skill 与拼接后的用户文本做排名。命中项被渲染成一条 `<system-reminder>` 消息，来源为 `{ kind: 'plugin', plugin: 'dsh-tool-skill', form: 'catalog' }`，追加在该步骤所有其他注入之后。同一轮的后续步骤不注入任何内容：第一份清单仍在上下文中。可见性检查针对本插件所注册的精确工具定义，因此作用域内同名的遮蔽项会同时移除 schema 与清单；该插件既可全局挂载，也可挂在单个 agent 的组合内。

### 调用边界

`/name` 手势监听器只扫描已认领的用户消息：若某个以空白为界、指名工作区目录中用户可调用 skill 的 token 出现，则把同一份 `<skill_content>` 渲染作为 `user` 角色的指令上下文注入。它注册在检索监听器之前，因此一个既点名牌技能又检索清单的步骤，最后落地的是被注入的正文——背景在前，模型要着手处理的材料离答案最近。未知名称与用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，检索清单与 `skill` 工具永不暴露这类 skill。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从排名输入背后的注册表词汇逐步进入精确工具 schema 与设计依据。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——清单所排名的注册表与提供方词汇。
- [skill 包](../skill/README.zh.md)——注册表、BM25 排名原语，以及共享的 `renderSkillContent` 渲染。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)——模型接收的精确 `skill` schema。
- [用户显式 skill 调用 Agent Note](../../../.agents/notes/archived/feature/2026-08-08-user-explicit-skill-invocation.md)——`/name` 手势设计。

-----

<a id="model-experience"></a>
## 模型体验

### 检索清单

#### 模型看到什么

在一轮的第一个步骤，如果存在模型可调用 skill，且可见的正是这个 `skill` 工具，该步骤的消息批次会在末尾多出下方这条提醒，其中包含每个已排名 skill 的一条随数据而定的条目，以及一个说明本会话共持有多少个 skill 的抬头。这个块不是持久状态：下一轮会追加一份自称后继者的新清单，因此掉出选择的名称由后继者停用，而不是靠一条显式空替换。结尾两句话承担安全规则——清单只有摘要，且清单是一份选择而非全部目录，所以未列出的 skill 仍可按名称加载。中文语言会翻译这段框架和每条已存档描述，同时保留 XML 标签、skill 名称与工具名称。

##### 检索清单模板

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. These are the skills most relevant to the current request (this session holds <total> in total; <listed> listed here). This list supersedes any earlier skill list:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This list contains summaries only; do not infer or follow a skill's instructions until it has been loaded. The list is a selection, not the whole catalog — a skill it does not mention can still be loaded by name.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

#### Token 影响

重复输入成本由 `retrievalMaxResults` 与 `catalogDescriptionMaxLength` 界定，而不随注册表规模增长：一轮一份清单，无论该轮走了多少个步骤。当该步骤没有直接用户文本、命中为空、或工具被隐藏或遮蔽时，不会添加任何 token。

#### KV Cache 影响

清单落在该步骤的消息批次内、可重用请求前缀之后，因此清单变化永远不会改写更早的 token。由于一轮只追加一份清单，保留成本是每轮一条消息，而不是每步一条。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`skill` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-skill)。

#### Token 影响

工具可见时，每次请求都有固定的 schema token 开销。

#### KV Cache 影响

工具定义和可见性不变时，前缀稳定。遮蔽、限制或插件生命周期变更可能从该 schema 起使重用失效。

### 工具结果

#### 模型看到什么

成功调用使用下方结果模板，以及提供方管理的资源指引、目录资源指引、URL 资源指引或不透明资源指引。

##### Skill 结果模板

```markdown
<skill_content name="<escaped-name>">
<skill_resources>
<resource-guidance>
</skill_resources>

<skill_instructions>
<provider-owned-instruction-body>
</skill_instructions>
</skill_content>
```

##### 提供方管理的资源指引

```markdown
Resources for this skill are managed by provider "<provider>".
Load referenced resources only as needed.
```

##### 目录资源指引

```markdown
Base directory for this skill: <path>
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
```

##### URL 资源指引

```markdown
Base URL for this skill: <url>
Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.
```

##### 不透明资源指引

```markdown
Resources for this skill: <description>
Load referenced resources only as needed.
```

#### Token 影响

已加载指令是取决于数据的工具结果 token，并在后续步骤中重新发送，直到压缩；不会制作重复的 `agent.inject()` 副本。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 工具错误

#### 模型看到什么

无效或陈旧选择会精确返回 `Error: invalid skill name "<name>"`、`Error: skill "<name>" is unknown or no longer available` 或 `Error: skill "<name>" is not available for model invocation`。提供方抛出的查找文本取决于数据，并套用同一个 `Error: <message>` 包装层。

#### Token 影响

只有失败调用会添加这些已保留 token。

#### KV Cache 影响

仅追加；新可见内容位于可重用请求前缀之后，不会使现有 KV Cache 条目失效。

### 用户显式调用注入

#### 模型看到什么

已认领用户消息中任意位置、以空白为界、指名工作区目录中某个用户可调用 skill 的 `/name` token，会把该 skill 的完整 `<skill_content>` 渲染（与上文结果模板完全相同的形态）作为 `user` 角色的指令上下文注入，追加在该步骤所有其他注入之后——背景在前，模型要着手处理的材料在最后，排在同一步骤可能已追加的检索清单之后。只扫描直接的用户输入，检查在已加载定义上进行，未知名称和用户不可调用的名称保持为普通行文。这是 `disable-model-invocation` skill 唯一的入口，检索清单与 `skill` 工具永不暴露这类 skill；清单的结尾一句会告诉模型遵循注入块，而不是重新加载它。

#### Token 影响

每次手势会把一份渲染后的 skill 正文作为注入上下文加进该轮次——尺寸与同一 skill 的工具结果相同，该成本会随用户请求必然产生，而非由模型自行决定。同一步骤内对同一 skill 的重复手势只注入一次。

#### KV Cache 影响

仅追加；注入落在该步骤的消息批次中、可重用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明检索清单或加载器何时不合适。它们是当前包约束，不是任务积压。

- **检索可能漏掉**——清单最多点名 `retrievalMaxResults` 个 skill，且由名称与描述上的词法 BM25 选出；措辞与请求不匹配的 skill 不会出现在清单里，只能按精确名称加载。
- **打分只读直接用户文本**——工具结果、注入的上下文与中继消息都不参与，因此完全由工具结果描述的任务不会产生清单。
- **清单省略 `whenToUse`、来源和提供方元数据**——路由只基于名称和有长度上限的描述；`whenToUse` 仍是提供方元数据，加载后的包装层也不渲染它。
- **已加载指令正文没有大小上限**——提供方可返回足以占用大量下一步上下文的 skill；只有清单描述会被截断。
- **资源是指引，而非附件**——工具报告基础目录/URL/不透明提示，但既不列举也不为模型获取引用文件。
- **加载是一次性文本**——远程提供方缓慢或 skill 正文很大时，不提供部分内容、流式输出或缓存内容句柄。
- **正文不做版本化**——仅修改正文既不改变排名输入也不改变清单，因此不会有任何宣告；后续工具调用会读取提供方的当前内容，而先前工具结果仍是历史事实。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
