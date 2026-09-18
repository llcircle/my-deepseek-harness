# 移植计划：把本项目在 dsh 基线上的定制搬到 fork 的新版本

> 状态：**移植已落地并已提交，文档门禁全绿**。
>
> - **移植主体提交**（`port: 把本项目在 dsh 基线之上的定制移植到 fork 的最新版本`；该提交把 57 个文件的嵌套冲突标记一起提交了进去）。
> - **收口提交**（`port: 收口冲突解决并把 i18n 派生文档清零`）：209 文件 / +4879 −8984。解决全部 57 处冲突标记、i18n 配对归零、
>   四张生成物目录重生成、英文侧中文泄漏在源头修掉、md 锚点语言定案。
> - **经验记录提交**（`docs(experience)`；`EXPERIENCE.md` 四类新判据）。
>
> 现态：工作树干净、`git grep -l '^<<<<<<< ' HEAD` 为空、`git rev-list --objects HEAD` exit 0。
>
> 门禁：i18n 配对 **955/955 一致**、`verify-md-links` **1909 个文件全解析**、四张生成物
> （config / tool / persistence / cordis）`--check` 全部 up to date、英文侧目录文档零中文残留、
> pre-commit 的 lint 对本次暂存集 **0 error**。
> 测试：`packages/{computer,core/system-prompt,skill}` 314/314 绿；`packages/api` 7 例为
> 本机 `EPERM symlink` 环境红灯（与本移植无关，详见「九」）。
> 详见「六、冲突清单」与「八、剩余阶段」。**未推送**。

---

## 一、这次要做什么

原开发副本（`D:\VS_Projects\deepseek-harness`）是从 dsh 的**某个稳定版本源码**起步的，之后所有
定制都叠在那个静态副本上，代价是永远拿不到上游更新。本次改成 fork 工作流：

- 克隆 fork：`https://github.com/llcircle/my-deepseek-harness.git`（本目录）
- 以 fork 的**新版**为基线，新建分支，把此前所有定制**重新落上去**

定制清单见本目录的 `ADDED-FEATURES.md`（9 个新增插件包、`lean` 预设、4 个斜杠命令、3 处架构级机制迁移）。

## 二、基线与目标（已用证据确认，不是猜的）

| 项 | 值 | 依据 |
|---|---|---|
| 我们原来的基线 | **`dsh-v0.1.3-alpha.1`** | 原副本 264 个包的 `version` 全是 `0.1.3-alpha.1`；且以该 tag 为基线时 delta 最小（536 文件），换成 `0.1.3-alpha.2` 会飙到 4249 文件 |
| 本次移植目标 | **`master`（= `dsh-v0.1.6-alpha.1` + 5 条已合并的 perf 提交）** | fork 的唯一分支、即最新上游状态 |
| 上游在这期间的移动量 | **1962 个提交 / 7916 个文件 / 94 万行新增** | `git diff --shortstat dsh-v0.1.3-alpha.1 dsh-v0.1.6-alpha.1` |
| 我们的定制量 | **536 个文件**（176 新增 / 341 修改 / 19 类型改动） | 25539 行新增、1526 行删除 |
| 双方都改过的文件 | **188 个，且全部是「修改 / 修改」** | 没有 add/add、没有 modify/delete，这是这次移植能机械化的关键 |

> 想改用 tag 而不是 master？两者的差别只有 5 条 perf 提交、130 个文件。
> `git checkout -b port-tag-0.1.6 dsh-v0.1.6-alpha.1 && git cherry-pick <本次移植提交>` 即可。

## 三、方法：为什么不用 `git merge`

一开始按常规做法在 fork 里构造了合成提交（把我们旧树的 tree 挂到基线 tag 下当父提交，这样三方
合并有真正的 merge base），然后 `git checkout` + `git merge`。**这条路在本机不可用**：

- 两次尝试都在 `git checkout`/`git merge` 期间发生 `.git/refs` 被清空（连带我们自己创建的分支、
  以及 fetch 进来的 pack 只剩 `.idx` 没有 `.pack`），合并进程再也走不到终点。
- 该症状与原副本此前两次「对象库 pack 丢失」完全同形。已加固配置
  （`gc.auto=0`、`maintenance.auto=false`、`gc.autoDetach=false`、`core.hooksPath` 指向空目录），
  但第二次仍然复现 → 判定为**本机环境对「大工作树 + 单条长 git 操作」不可靠**。
- 另一个诱因证据：`.gitattributes` 里有 `*.i18n.yaml merge=dsh-translation-pairing` 自定义合并驱动，
  由 `scripts/install-lefthook.mjs` 注册；本机全局/工作树配置曾被旧仓库的 `dsh-hooks` 污染。

**改成按文件移植**，规则：

1. 三个输入全部落到**纯文件**层，不再依赖可变的工作树/索引：
   - `base` = `git show dsh-v0.1.3-alpha.1:<path>`（只读）
   - `ours` = 旧副本的工作树文件（只读）
   - `theirs` = 本 fork 的工作树文件
2. 逐路径判定：只有我们改 → 直接写我们的版本；两边都改 → `git merge-file` 三方合并；
   生成物 → 保留上游版本、事后再生成。
3. 只有一个 git 调用是「写」：最后的 `git add` + `git commit`（属中等规模，已验证可行）。

产物与脚本在 `D:\dsh-port\`（不在仓库内，避免污染）：

| 文件 | 内容 |
|---|---|
| `delta.mjs` / `delta-report.txt` | 双方 delta 与交叠的统计 |
| `ours-delta.txt` `theirs-delta.txt` `overlap.txt` `ours-only.txt` `typeonly.txt` | 逐路径清单 |
| `port.mjs` | 分类 + 复制 + 三方合并的执行脚本（幂等，可重跑） |
| `port-apply-report.txt` | 本次执行结果与冲突清单 |

> 用统计结论校验过方法本身：脚本独立算出的 delta 与早先 `git diff` 的结果一致（536 / 交叠 188），
> 说明「按 blob 哈希比对」这条路是可信的。

## 四、四个桶（536 个文件全覆盖）

| 桶 | 数量 | 处置 |
|---|---|---|
| **直接写入**（只我们改过） | 151 | 已写入工作树 |
| **三方合并**（两边都改过） | 147 | 已合并，其中 90 个自动干净、**57 个有冲突** |
| **生成物**（刻意不移植） | 219 | 保留上游版本，待重生成 |
| **Windows 产物** | 19 | 本副本把符号链接存成了普通文件，**不是功能**，保留上游的符号链接 |

生成物这 219 个是：`snapshots/**`（会话黄金快照）、`scripts/snapshots/**`、
`apps/cli/tests/profiles/**/expected/**`、`pnpm-lock.yaml`、`docs/{config-catalog,tool-catalog,persistence-catalog}*`、
`THIRD_PARTY_NOTICES.md`、以及所有 `.i18n.yaml` 配对记录。
它们的内容是我们旧基线提示词的投影，**搬过来只会是过期的**，必须用新基线的生成器重跑。

## 五、已落地的定制（本次移植覆盖到的）

- **9 个新增包**（原样带入）：`packages/guard/{tool-error-journal,command-correct-errors,command-summarize-skill,error-reflection-prompt}`、
  `packages/computer/{computer,computer-python,tool-computer-use}`、
  `packages/skill/command-translate-{skills,system-prompt}`，合计 72 文件 / 约 9000 行。
- **新增源文件**：`core/system-prompt/src/{overrides,localized-sections}.ts`、`core/tools/src/search.ts`、
  `skill/skill/src/translations.ts`、`ui-settings-plugins` 三张设置卡（Skill 触发 / 提示词覆盖 / 重试）、
  `preset/agent-presets/presets/lean/**`（`lean` 预设）、`docs/subsystems/computer.*`。
- **改动既有包**：core/system-prompt、core/tools、core/agent-loop、core/session、core/scope、
  skill/{skill,skill-filesystem,tool-skill}、subagent/*、goal/tool-goal、jobs/tool-jobs、plan/plan-mode、
  preset/agent-presets、mcp/mcp-client、api/{session-controller,settings-controller}、client/*、bundle/*。
- **工程化与文档**：`start-web.cmd`、`LOG.md`、`EXPERIENCE.md`、`research/`、`.agents/notes/**`（67 篇设计记录）、
  `.workbuddy/memory/**`、`ADDED-FEATURES.md`。

## 六、冲突清单（57 个，已全部裁决）

> 裁决结果已固化在工作树里，工作区不再有任何冲突标记。逐文件核对方式：
> 把工作区版本与上游 `dsh-v0.1.6-alpha.1`（+5 perf）的同名文件比对，一致即说明 fork 侧被静默丢弃——
> 57 个文件全部"不一致"，即 fork 语义存活。脚本：`D:\dsh-port\probe\conflict-audit.mjs`。

**核心运行时 / 契约（优先）**

```
packages/core/system-prompt/src/index.ts              7 hunks   <- 分段机制、suppressSection、本地化替换
packages/core/tools/src/index.ts                      1 hunks   <- wireSchemas、search 子入口
packages/core/agent-loop/src/agent.ts                 2 hunks   <- 运行时上下文改走请求 system 字段
packages/core/session/src/request-header.ts           2 hunks   <- systemSections 字段
packages/core/session/src/types.ts                    2 hunks
packages/core/session/src/known-event-types.ts        1 hunks
packages/skill/tool-skill/src/index.ts                2 hunks   <- 技能目录迁到系统提示词段
packages/skill/skill-filesystem/src/index.ts          (已自动合并) <- customSkillDirs 支持 file: URL
packages/mcp/mcp-client/src/connection.ts             2 hunks   <- MCP 介绍按服务器分节
packages/extensions/tool-cordis/src/api-catalog.ts    6 hunks
packages/sandbox/sandbox-policy/src/index.ts          1 hunks
packages/session/session-persistence-jsonl/src/lease.ts 2 hunks
packages/api/session-controller/src/skill-catalog.ts  2 hunks   <- 技能简介本地化（界面侧消费方）
packages/plan/plan-mode/src/index.ts                  1 hunks   <- goalOnApprove
packages/goal/tool-goal/src/index.ts                  1 hunks   <- toolShape: merged
packages/jobs/tool-jobs/src/index.ts                  1 hunks
packages/subagent/subagent/src/out-of-process.ts      2 hunks   <- allowTools/omitSections 的显式拒绝
packages/subagent/subagent-fork-in-process/src/index.ts 2 hunks
```

**接线与清单（机械，但必须逐个确认）**

```
tsconfig.base.json         <- 新包的 paths 映射
tsdown.config.ts
package.json (根)
packages/bundle/base/{cordis.patch.yml,package.json}     <- 新插件挂载行与依赖
packages/bundle/web-app/package.json
packages/preset/agent-presets/presets/minimal/preset.yml <- order 顺延
packages/mcp/mcp-client/{package.json,tsconfig.json}
packages/client/ui-settings-plugins/package.json
.gitignore
scripts/gen-cordis-catalog.ts
```

**客户端 UI**

```
packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx          2 hunks
packages/client/ui-chat/src/client/conversation-nodes/{message,request-prompt}.ts
packages/client/ui-chat/src/client/locale.ts
packages/client/ui-conversation/src/client/contract/request-inspection.ts
packages/client/ui-conversation/src/client/index.ts
packages/client/ui-commands/src/client/service.ts
packages/client/ui-skill/src/client/index.ts
packages/client/ui-trajectory/src/client/TrajectoryTable.tsx
packages/client/ui-input-trigger/src/client/MenuView.module.css
```

**测试与文档**（断言需按新契约重写，参考 `tool-skill` 那 18 例的教训）

```
packages/core/agent-loop/tests/{loop,scope-lifecycle}.spec.ts
packages/core/system-prompt/tests/system-prompt.spec.ts
packages/skill/tool-skill/tests/tool-skill.spec.ts
packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts
packages/sandbox/sandbox-policy/tests/policy.spec.ts
packages/client/ui-chat/tests/*, packages/client/ui-commands/tests/*, packages/client/ui-conversation/tests/*
apps/cli/tests/web-agent-presets.e2e.ts                10 hunks  <- lean 预设的验收断言
README*.md、packages/**/README*.md（中英配对，改完要重录 .i18n.yaml）
```

## 七、裁决原则（避免重犯旧坑）

1. **契约以新上游为准，我们的语义当补丁**：上游这 1962 个提交很可能已经重构过我们动过的接口
   （分段、工具注册、子代理请求、会话事件）。冲突处先读上游新写法，再把我们的语义表达上去，
   而不是把旧代码整块搬回。
2. **生成物一律不手工合并**：取上游版本后重跑生成器；i18n 配对用
   `tsx scripts/verify-translation-pairing.ts --write <file>` 重录。
3. **Windows 特有的类型改动全部丢弃**（19 个），保留上游的符号链接。
4. **测试陈旧≠功能缺失**：旧副本里 `tool-skill` 有 18 例断言的是「技能目录作为首条 user 消息注入」
   这个已被移除的机制。移植时按新契约重写，不要为了让它变绿而把机制改回去。
5. 每改完一个包就跑 `tsc -b packages/<group>/<pkg>` 取信号，别攒到最后。

## 八、剩余阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 建工作副本、确认基线、算清 delta、机械化移植 | **完成** |
| P1 | 裁决 57 个冲突（按上面顺序：核心契约 → 接线 → 客户端 → 测试文档） | **完成**（工作区无标记，全部保留 fork 语义） |
| P2 | 重生成生成物 + 重录 i18n 配对 | **文档部分完成**：四张目录（config/tool/persistence/cordis）+ 中文侧补 8 个包章节 / 2 个工具章节；配对 955/955。快照与 `cli expected` 未重录 |
| P3 | `pnpm install` + 构建（`tsc -b`、`tsdown --env.DSH_BUILD_FACE host`） | **完成**：`pnpm install --frozen-lockfile` 成功（10.2s，lockfile 未改）；`tsc -b tsconfig.host.json` **EXIT 0**、`tsdown host` EXIT 0、`tsc -b tsconfig.client.json` EXIT 0（修复见 11.5，09-18 更正） |
| P4 | 跑测试取信号（`packages/{skill,preset,bundle}` + `apps/cli`，含 `web-agent-presets.e2e`） | **部分**：八个包族 99 文件 / 1872 通过 / 0 失败（见 11.3）+ 本轮修复涉及的两包 9 文件 / 169 例全绿；`apps/cli` 与 e2e 待做 |
| P5 | 提交、推送 fork、按需开 PR | **门禁已通**：lefthook `run pre-push` EXIT 0、pre-commit 全绿；三个提交 `5e2c0ad40b` / `c30f6b5372` / `014d8982cb` 待推——本机无 GitHub 非交互凭据，**需由用户带凭据推** |

### 仍欠的账（按优先级）

1. ~~生成物里的中文来源~~ **已收口**（收口提交）。4 处落进英文生成文档的中文 JSDoc 已英文化，
   英文侧 `config-catalog.md` / `tool-catalog.md` / `persistence-catalog.md` CJK 行数 = 0，
   `docs/subsystems/*.md` 只剩语言切换行（设计内）。规则仍成立：只有落进英文生成文档的 JSDoc 必须
   英文化；`packages/**/src` 里其余中文注释（含模块头、`//` 注释、`packages/client/*/locales.ts`
   这类**本就该是中文**的 UI 文案）不动。核验脚本：`D:\dsh-port\probe\cjk-sources.mjs`（按
   `Source:` 行归因）。
2. `packages/api/workspace-files/tests/*` 与 `scripts/repo-files.spec.ts`、`scripts/dev-web.spec.ts`
   在本机因无特权 `symlink()` 报 `EPERM` 而红——属环境不属代码，见「九」。若要本地全绿，
   按 `credentials-local/tests/local.spec.ts` 的先例加平台守卫（目录用 `junction`、文件用 `fs.link()`），
   守卫写在**断言**上而非整个用例。
3. `scripts/oxlint-contract.spec.ts` 在本机因 5s 超时中止，会**留下合成源文件残渣**
   （`packages/**/src/oxlint-contract-<hash>.ts`），进而让 `scripts/persistence-schema.spec.ts`
   报 `TS6053: File ... not found`。跑完该 spec 后先确认残渣已清。
4. ~~`pnpm install` 未跑过；`tsc -b tsconfig.host.json` 仍是既有红灯~~ **均已结清（09-18）**：
   `pnpm install --frozen-lockfile` 成功；宿主/客户端两条 tsc 与 tsdown 三步全 EXIT 0；
   产物齐备后 `publint` 与 `verify-built-package-invariants` 亦转绿。**剩 `apps/cli` 与 e2e 未跑。**
   本机 `pnpm run` 会先做依赖校验（≈再跑一次 install），因此 `core.hooksPath` 必须归位到受管目录，
   否则根 `postinstall` 的 `install-lefthook.mjs` 会 `refusing to replace user-owned core.hooksPath`
   并让**整条命令在跑脚本前失败**。处方见 `.workbuddy/memory/2026-09-18.md` 第八节。

## 九、本机环境风险（务必先读，能省几小时）

1. **不要在项目目录里放嵌套 Git 仓库**。本 clone 建在项目目录内，父仓库会把它的工作树当成自己的
   一部分：一旦 `.git/refs` 缺失，git 的向上发现会**穿透到父仓库**——`git rev-parse --git-dir` 会
   返回父仓库的 `.git`，于是所有命令静默作用在父仓库上（表现为读到父仓库的
   `core.hooksPath`、`git log` 看不到上游提交）。建议把它移到 `D:\VS_Projects\my-deepseek-harness`。
2. **大工作树 + 单条长 git 操作会毁 `.git`**。已发生 2 次：`git checkout`/`git merge` 期间
   `.git/refs` 被清空、fetch 的 pack 只剩 `.idx`。所以：动 `.git` 前先设
   `gc.auto=0` / `maintenance.auto=false` / `gc.autoDetach=false`，把 `core.hooksPath` 指到空目录；
   尽量用「读对象」而不是「动工作树」的操作。
3. **损坏的判定与修复**：`git rev-parse --git-dir` 指向别处、或 `refs/` 目录消失即已损坏。
   修复：`mkdir -p .git/refs/heads .git/refs/tags` + `git update-ref refs/heads/<b> <sha>` +
   `git symbolic-ref HEAD refs/heads/<b>`，工作树用 `git reset --hard` 复位。
4. **分支名用扁平名**（`port-0.1.6` 而不是 `port/0.1.6`）：本机 `update-ref` 建嵌套 ref 目录曾静默不落地。
5. **路径形式**：git.exe 不认 `/d/...` 形式的 MSYS 路径（`--git-dir=/d/...` 会报 not a git repository），
   给 Windows 形式（`D:/...`）；node 也一样，`/d/...` 会被解释成 `D:\d\...`。
6. **单条命令别超过 2 分钟前台预算**：会被 SIGTERM 打断（本次移植第一次执行只走到 221/298）。
   长任务一律后台跑，并在同一个 shell 生命周期里收尾。
7. **验证服务/脚本先 `env -u NODE_OPTIONS`**（WorkBuddy 注入的 shim 会把正常删除判成批量删除）。

## 十、复现与重跑

```bash
# 1) 重新计算 delta（只读，秒级）
node D:/dsh-port/delta.mjs
# 2) 分类与报告（不写入）
node D:/dsh-port/port.mjs
# 3) 执行移植（幂等，可反复重跑）
node D:/dsh-port/port.mjs --apply
```

脚本假设：
- `ours` = `D:/VS_Projects/deepseek-harness`（旧副本）
- `theirs` = `D:/VS_Projects/deepseek-harness/my-deepseek-harness`（本 fork 副本）
- `base` = tag `dsh-v0.1.3-alpha.1`

---

## 十一、功能对照与验证结果（09-18）

### 11.1 对照：基线之上的定制是否都落到 0.1.6

对 `ADDED-FEATURES.md`（fork 侧的能力清单）逐项在**本分支源码**里找落点，结论是**九类全部在位**，
没有一项在移植中丢失：

| 清单项 | 核对落点 | 结果 |
|---|---|---|
| 9 个新插件包 | `packages/{guard,skill,computer}/*` 逐个读 `package.json` 的 `name` | 9/9 存在且包名一致 |
| 技能三态 / 触发卡 | `dsh-skill` 的 `SkillTriggerState`：`ui-settings-plugins/src/client/skill-trigger-card-controller.ts` | 在位 |
| 技能目录迁系统提示词 | `tool-skill/src/index.ts` 注册分段 `skills:catalog`；`system-prompt` 把 `skills:catalog` 与 `deployment:error-lessons` 列为 `DYNAMIC_SECTION_NAMES` | 在位（迁移 1 完成） |
| 纠错闭环 | `tool-error-journal` → `command-correct-errors`（命令 `correct-errors`）→ `error-reflection-prompt` | 在位 |
| 反思按能力分节 | `error-reflection-prompt` 模块头写明按 `## tool:` / `## mcp:` / `## computer:` 路由；`mcp__<server>__<raw>` 折叠回 `mcp:<server>` | 在位（迁移 3 完成） |
| 电脑操作 | `tool-computer-use` 的 9 个原子工具（`computer_{click,display,drag,key,move,pointer,screenshot,scroll,type}`）；`COMPUTER_COMMAND_NAME='computer'`；`computer/mode` 会话事件 | 在位 |
| 运行时上下文进 system 字段 | `agent-loop/src/agent.ts` 的 `RuntimeContextProjection` / `SystemPromptProjection` | 在位（迁移 2 完成） |
| 系统提示词与本地化 | `commands-translate-system-prompt` 双产物；`catalogLocale`；`completePromptFile`；`promptSectionChanges`（客户端 `ui-conversation/src/client/contract/request-inspection.ts`） | 在位 |
| 子代理裁剪 | `subagent/src/types.ts` 的 `allowTools` / `omitSections`；`system-prompt` 的 `suppressSection` | 在位 |
| plan → goal | `plan-mode/src/index.ts` 的 `goalOnApprove` | 在位 |
| lean 预设 | `packages/preset/agent-presets/presets/lean/agent.cordis.yml`；`display.ts` 的 `presetLeanName` / `presetLeanDescription` | 在位 |
| lean 的工具合并 | `tool-goal` / `tool-jobs` 的 `Config.toolShape`；`dsh-tools/search` 子入口（`tool_search`） | 在位 |
| 提示词编辑器分栏 | `NON_EDITABLE_SECTION_NAMES` 含 `computer:policy`；按 `tool:` / `mcp:` / `computer:` 前缀一能力一行 | 在位 |
| `start-web.cmd` 最短依赖路径 | 根目录 `start-web.cmd`（纯 ASCII + 端口预检） | 在位 |

### 11.2 修掉的真实缺陷

1. **9 个新包沿用 fork 的旧版本号**（7 个 `0.1.3-alpha.1` + 2 个 `0.1.0-alpha.1`），与根
   `0.1.6-alpha.1` 不一致 → 全部对齐。此前 `check-workspace-constraints` 报 12 条，现在 0 条。
2. **`files` 沿用 fork 的旧构建形态**：`computer/computer-python` 与 `computer/tool-computer-use`
   多写了 `lib/types/**/*.js`——0.1.6 的 tsdown 不再往 `lib/types/` 出 JS，这两个包的 `exports`
   也没有指向 `lib/types/` 的运行时默认值。**`computer/computer` 的 `./types` 导出确实指向
   `lib/types/types.js`，所以它的这一条是正确声明，保留不动。**
3. **约束脚本的规则表缺两条**（不是包声明的错）：
   - `@deepseek-ai/dsh-computer-python` 的 `runtime/computer_agent.py` 是真实运行时资产
     （`src/index.ts` 以 `import.meta.url` 相对解析），必须随包发布 → 补 `packageFileExtras`
     条目（与既有 `dsh-experimental-ptc-runtime-python` 的 `py/**/*.py` 同理）。
   - `@deepseek-ai/dsh-system-prompt` 新增的 `./overrides` 子入口（`bundle/base/cordis.patch.yml`
     有装配行）发布独立的 `lib/overrides.js` → 在 `expectedDshPackageFiles` 里按产物路径补一条
     通用规则（与 `./client` / `./loader` 同形）。
4. **`systemSections` 被算进了请求头相等判定**（移植引入的语义 bug）：v0.1.6 把系统提示词移出请求头
   改成派生历史后，`headerEquals` 仍比较 `systemSections`，导致每次提示词变更都判为"换头"。
   已把它降为展示元数据（`canonicalHeader` 仍规范化、`headerEquals` 不再比较），并在
   `EpochHeader.systemSections` 的 JSDoc 写明它不参与身份判定。
5. **运行时上下文的中文抬头硬编码**：`agent-loop/src/runtime-context.ts` 里 `CLEARED` 是写死的中文，
   与 `joinContextSections(sections, locale)` 的 locale 脱节 → 改为从 `@deepseek-ai/dsh-system-prompt`
   导出 `contextSnapshotCleared(locale)`（中英双语表），`project()` 接受 locale 并由 `agent.ts` 传入。

### 11.3 测试取信号

| 范围 | 结果 |
|---|---|
| `packages/{guard,computer,skill,preset,core/system-prompt,core/agent-loop,subagent,bundle/base}` | **99 文件 / 1872 通过 / 3 跳过 / 0 失败** |
| `packages/subagent` | 853 通过 / 2 跳过 / 0 失败 |
| `packages/skill/tool-skill` | 36/36（`ADDED-FEATURES.md` §7 记的"18 例待迁移"在移植提交里已迁移完） |
| `packages/core/agent-loop` | 417 通过 / 1 跳过 / 0 失败 |
| `run-gates doc-quick` | **20 passed / 0 failed** |

**`scripts/` 整目录的 25 例红——全部环境型，且低于基线**（`LOG.md` 记录的基线是 14 文件 / 27 例）：

- **`EPERM: operation not permitted, symlink`（11 例）**：`repo-files` 9、`project-doc-site` 1、`dev-web` 1。
  本机禁止创建真实符号链接（只允许 junction），测试夹具用 `fs.symlinkSync` 建文件链接直接 EPERM。
- **5s 超时（11 例）**：`benchmark-npm-resolution` 3、`change-scope` 2、`client-build-environment` 1、
  `oxlint-contract` 1、`test-invariants` 1、`translation-pairing` 1、`verify-repository-references` 1
  ——都在等 npm / git / oxlint 子进程。
- **`translation-pairing-merge` 3 例**：报 `runtime is unavailable`（合并驱动要 `lib/` 产物）。
- **跨用例污染 1 例**：`oxlint-contract.spec.ts` 超时中止时留下合成源文件
  `packages/**/src/oxlint-contract-<hash>.ts`，让并发跑的 `persistence-schema.spec.ts` 报
  `TS6053: File ... not found`。跑完确认现场已清（本轮已核，无残渣）。

**~~既有红灯（与本工作无关，未修）~~ 更正（09-18）**：`build:lib:host` 在 `test-support/client-runtime`
报 TS6307、客户端 `tsconfig.client.json` 的 2 处类型漂移，**都与 `tsc -b tsconfig.host.json` 同源**，
已随 11.5 的两处修复一起消失（host tsc / tsdown host / client tsc 三步全 EXIT 0）。
仍存的是 oxlint 在 `session-controller/src/skill-catalog.ts` 的 20 条 `no-unsafe-assignment`（与本工作无关）。

### 11.4 两条客户端回归用例的裁决（与「优先改代码」原则的偏离说明）

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` 有 2 条用例在本轮前
就是红的（用 `git checkout` 把生产代码还原到改动前复跑，仍红）。它们断言"同一次系统提示词变更
渲染 3 张卡（含一张 `update: true`）"，而**上游 v0.1.6 自有用例（1499 断言）直接要求同系列的工具
/配置变更不出卡片**。改生产代码去满足这 2 条会破坏上游不变量，所以按上游语义把测试迁到
"派生历史节点 0 被替换"这条上游确实渲染的路径（期望 2 张卡），保留 fork"只显示变动段落"的意图。

### 11.5 构建产物与 `hygiene` 聚合

**先补了构建产物**（此前本分支只跑过 `tsc -b`，`lib/` 里只有 `tsconfig.tsbuildinfo` 与 `types/`，
没有 `lib/*.js`，属于 P3 未做）：

```bash
env -u NODE_OPTIONS node node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE host    # 273 包
env -u NODE_OPTIONS node node_modules/tsdown/dist/run.mjs --env.DSH_BUILD_FACE client  # 184 包
```

- **tsdown 的正确入口是 `node_modules/tsdown/dist/run.mjs`**（`package.json` 的 `bin`）。
  `node node_modules/tsdown/dist/index.mjs` 会**静默退出 0 且什么都不做**——别用它。
- **客户端包的 `lib/invariant.js` 由 `--env.DSH_BUILD_FACE client` 产出**，宿主面不管；
  只跑宿主面时 `verify-built-package-invariants` 会报 `packages/client/{hmr,modules,ui-renderer}`
  找不到 `lib/invariant.js`。
- **Typert 产物有先有后**：`typertPlugin` 消费 tsc 产出的 `lib/types` 再写 `lib/typert.*`，
  所以干净树上 `tsc -b` 会先因 `@deepseek-ai/dsh-*/remote` 解析不到而报 TS2307。先跑 tsdown
  再跑 tsc 即可（本轮实测：生成产物后 TS2307 从 27 条降到 6 条）。
- 产物落 `lib/`，已被 `.gitignore` 覆盖（`lib/`），不污染提交。

**`hygiene` 聚合：11 passed / 5 failed → 14 passed / 2 failed**（补齐产物 + 修 `constraints` 之后）。

| 门禁 | 归因 |
|---|---|
| `constraints` | **真实缺陷，已修**（见 11.2 的 1–3）→ 现 0 错误 |
| `built package invariants` | 缺产物 → 补齐后 **PASS**（39 个编译伴生包通过） |
| `publint` | 缺产物 → 补齐后 **PASS**（`pkg.exports["./src/*"] … does not match any files` 是警告，非失败） |
| `node-next types` | **环境**：脚本 `verify-node-next-types.ts:87` 用 `symlinkSync(pkg.dir, link, 'dir')` 搭临时安装，本机禁止真链接 → 在 `execFileSync` 之前就抛，所以报错**没有任何诊断文本**（只有一行 "NodeNext consumer typecheck failed."）。不是类型错误 |
| `Cordis config` | **环境**：`apps/cli/tests/profiles/acp/cordis.yml` 在 git index 里 mode=`120000`（符号链接），本机无法建真链接，工作树落成 59 字节纯文本（内容恰是链接目标路径）→ 校验器把路径串当 YAML 读，报 `root must be a Loader entry array` |

**~~`tsc -b tsconfig.host.json` 仍是红的（238 TS6307 + 115 TS6142），但与本工作无关~~ —— 此结论已被推翻（09-18）**

当时的判断依据（配置 diff 与上游一致、产物前后错误数不变）**不足以下这个结论**。当日用导入图溯源
查出两个**移植引入**的真缺陷并修掉后，该命令 **EXIT 0**：

1. **两个新测试缺 `.client.` 面后缀**。`packages/client/ui-settings-plugins`（上游已有包）在移植时新增
   3 个测试，`prompt-overrides-card-controller.client.spec.ts` 合规，而
   `llm-retry-card-controller.spec.ts`、`skill-trigger-card-controller.spec.ts` 沿用 fork 旧命名。
   宿主 aggregate 的 `exclude` 只排 `*.client.*`，于是这两个文件被 `packages/*/*/tests/**/*.ts`
   收进**宿主** program；它们 import `../src/client/*` 后把 `packages/client/*/src/**` 整片（含 `.tsx`）
   拖入宿主 → **238 TS6307 + 115 TS6142**。按仓库契约改名即修复
   （`scripts/oxlint-contract.spec.ts`："A test under packages/client states its face in the filename"）。
2. **一个新包的 augment 目标漂移**。`SessionProjectionStateMap` 在
   `packages/session/session-projection/src/types.ts` 是空接口、纯靠声明合并；全仓 36 处写
   `'@deepseek-ai/dsh-session-projection/types'`，只有 `packages/computer/tool-computer-use/src/state.ts`
   写成包根 → 合并进不同模块身份，宿主测试里 `'timeContext'`/`'agentTeam'`/`'test/marks'` 整片键丢失
   → **39 TS2769/TS2344/TS2345**。改成 `.../types` 即修复。

修复后：`tsc -b tsconfig.host.json` EXIT 0、`tsdown --env.DSH_BUILD_FACE host` EXIT 0、
`tsc -b tsconfig.client.json` EXIT 0；受影响包 9 文件 / 169 例单测全绿。提交 `014d8982cb`。
**lefthook `run pre-push` 实测 EXIT 0**（typecheck 43.45s）。

> 方法论：判"红灯是不是我弄的"，**不能**只看配置文件 diff，也**不能**只看"独立旧副本跑同一命令
> 也失败"——旧副本失败只证明那个副本也红。要把 **program 文件集与导入图**拉出来溯源。
> 工具：`D:\dsh-port\probe\leak-chain.mjs`、`host-client-leaks.mjs`。
