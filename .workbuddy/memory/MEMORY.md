# 项目长期记忆 — deepseek-harness

跨会话成立的**项目级事实与判据**。逐日流水与完整过程在 `YYYY-MM-DD.md`，本文件只留"下次还会用到"的结论。

## 本机环境（Windows / Git Bash）

- **`NODE_OPTIONS` 被 WorkBuddy 注入 shim**（`node-safe-delete-shim.cjs`），会把正常删除判成批量删除、抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。**跑任何 pnpm / node 构建先 `env -u NODE_OPTIONS`。** 栈帧里出现 `D:\Programs\WorkBuddy\...` 即环境问题，不是代码问题。
- **不要用 `pnpm`**（无扩展名 sh 垫片被 git bash 改写成 `D:\d\...`）；**`pnpm run <script>` 也会崩在 corepack shim**。可靠写法：`node 'C:\Users\TDS\AppData\Local\node\corepack\v1\pnpm\11.7.0\bin\pnpm.mjs' <args>`，脚本一律跑 `./node_modules/.bin/{tsx,vitest,tsc}`。vitest 4 无 `--reporter=basic`。
- **curl 访问 `127.0.0.1` 必须加 `--noproxy '*'`**（`HTTP_PROXY=127.0.0.1:5802` 会吞本机请求，表现 502）。
- `git -C /d/...` 报 "cannot change to"（git.exe 不认 MSYS 路径参数）→ 用 `cd <dir> && git ...`；探针脚本路径给 `D:/...` 风格。
- 宿主 node 两套：系统 v24 与托管 v22.22.2；`--import tsx/esm` 用 PATH 上那个。

## 构建链

- **宿主 tsdown 入口固定为 `lib/types/{index,invariant,overrides,startup}.js`，不是 `src`**。改 `src` 必须 `tsc -b packages/<group>/<pkg>` 再 `tsdown --env.DSH_BUILD_FACE host`，否则产物静默陈旧——而 vitest 从 src 解析、全绿，完全掩盖。**验证要 grep 本次新增的独有文案**，grep 符号名无效。
- **`tsconfig.base.json` 的 `paths` 把 `@deepseek-ai/dsh-*` 映射到各包 `./src`**（397 条**精确**映射，无通配）→ `--profile web` 源码启动不过 `lib/`，E2E 验源码改动无需重建产物。
- 既有与本工作无关的红灯（别修）：`build:lib:host` 在 `test-support/client-runtime` 报 TS6307（受影响包单独 `tsc -b` 再跑 tsdown）；客户端 `tsconfig.client.json` 2 处类型漂移；oxlint 在 `session-controller/src/skill-catalog.ts` 的 20 条 `no-unsafe-assignment`；`verify-md-links` 在 `packages/computer/**/README.zh.md` 报 3 处坏锚点（指向 `docs/architecture.zh.md` 已改名的标题：`#session-日志`→`#会话日志`、`#新行为应该放在哪里`→`#新行为的归属位置`；改链接须同步重录 i18n 配对）；**`packages/skill/tool-skill` 单测 18/44 失败**——旧测试仍断言旧契约（技能目录作为 user 消息注入），代码已迁到系统提示词分段，`composePrefix`（读 user 消息）恒空。**撞到意料之外的红灯先 `grep -rn "<测试文件名>" EXPERIENCE.md LOG.md .workbuddy/memory/*.md`**，比读代码快一个数量级，也是唯一能区分"我弄坏了"与"它本来就红"的手段。
- `pnpm install` 会改写 `pnpm-lock.yaml`（对齐 workspace link）→ 非有意为之就 `git checkout -- pnpm-lock.yaml`。

## 启动与验证

- **`start-web.cmd` = `node --import tsx/esm apps/cli/src/bin.ts --profile web %*`**（等价 `"dsh"` 脚本）。别改回 `pnpm dsh`：`pnpm run` 先做一次依赖校验（≈再跑 `pnpm install`），安装期问题会伪装成"启动失败"。用户偏好：**走最短依赖路径，别把启动和装依赖焊在一条命令里**。
- **`pnpm dsh` 失败先怀疑 `pnpm install`**。已知安装期故障：lefthook 锁残留（`.git/dsh-lefthook-install.lock` 须人工删）、`core.hooksPath` 作用域错、`core.repositoryformatversion` 与 `extensions.worktreeConfig` 矛盾。
- **`--import tsx/esm` 不做热重载**：模块在进程启动那刻进内存，改 `src/*.ts` 零影响（只有 cordis.yml 是热重载的）。**改完源码必须重启进程**——本机有 09-13 起的实例占着 3080，用户拿它验证 09-14 新功能只看到老行为。排查：`netstat -ano` 找 PID → PowerShell `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` 看 `CreationDate`（`wmic` 本机无输出）。
- **可重载性与"源码启动"是两件事**：要不要重建产物看解析路径（`paths` 指 src 就不用），要不要重启看进程年龄（**永远要**）。
- 默认端口 **3080** 常有历史实例占着；启动器应预检端口并给"换端口"的可执行提示，别留成 `EADDRINUSE`。
- **验证服务一律带 `--no-open`、绑非默认端口、用完立刻停。** 3080 曾被上一轮留下的假模型后端（`DEEPSEEK_BASE_URL=127.0.0.1:9317/v1`）占 39 小时；排查"没生效"先怀疑自己留下的长驻进程。
- web 令牌**进程内随机**，每次从 stdout 的 `dsh web: http://…/?token=…` 重取；`GET /?token=…` 返 303 + `set-cookie: dsh-auth-<id>=…`，用这对调 Typert Remote（`POST /api/<namespace>/<method>`）。
- agent-browser 守护进程随 CLI 退出即消失：`open` 与后续命令须在**同一 shell 生命周期**；ref 仅同次会话有效；不可见元素先 `scrollintoview` 再 `click`。
- **e2e 走构建产物 `lib/`，单测走 `src`**（`paths` 直指 `./src`）。所以"src 已改、lib 陈旧"时单测全绿、e2e 报出**像真 bug 的错**（第三次栽：lean 挂载报 `ctx.tools.defer is not a function`，因为 lib 是 `deferred` 机制之前构建的）。报"本次新增的方法不存在"先怀疑产物年龄，别改代码。
- **boot 审计式 e2e 的隔离清单**（`apps/cli/tests/web-agent-presets.e2e.ts` 的 `bootWeb`）：① 绑端口/注入 `webServer` 的行（`webserver`、`web-runtime`、**web bundle 的 MCP 面板 `dsh-mcp-manager`**）必须 disable；② 写用户真实家目录的行钉临时根（`settings.path`、`storage-json.root`、`session-persistence-jsonl.root` —— 后者不钉则第二次跑必撞 `SessionAlreadyExistsError`）；③ 读用户真实家目录的行用**环境变量**钉（`DSH_AGENTS_HOME`/`DSH_HOME`/`DSH_BUNDLED_SKILL_DIR`），**别用 patch 行**（按 id 整条目替换）；④ roster 的 `default`/`includeUserRoot` 钉死。

## git（本机高危）

- **本仓禁止 `git stash`（任何形式，含 `-u`）。已毁库两次**。要"对照基线跑一次"用 `git worktree` 另开目录，或把文件 `cp` 出工作区再 `git checkout --` 还原。
- **止血配置（已长期设置）**：`gc.auto 0`、`maintenance.auto false`、`gc.autoDetach false`。
- 症状：`git log` 报 unborn 而 `git status` 满屏 `A`，`.git/objects/pack/` 只剩 `.idx` 没 `.pack`，`count-objects -v` 报 `in-pack: 0`。
- **校验完整性只看"HEAD 可达遍历"的 exit code**：`git rev-list --objects HEAD > /dev/null; echo $?`。**索引对象都在 ≠ HEAD 的树完好**（两者独立）；**别把 stderr 重定向掉数行数**，会吞掉 `fatal: bad tree object` 得到"0 缺失"的假结论。
- 恢复顺序、定位损坏点（逐层 `git ls-tree`）、`git mktree` 重建同哈希树、`rm .git/index` + `git read-tree HEAD` 等完整步骤见 `2026-09-15.md`。
- **推送**：`origin` 是 Gitee HTTPS，凭据内嵌 URL，`GIT_TERMINAL_PROMPT=0` 可推。`ls-remote`/`push` 偶发**静默挂死** → 加 `timeout`。`receive-pack` 上传被断连（`unexpected disconnect while reading sideband packet`）而读通道正常 → 非凭据问题，重试即可。pre-push 钩子跑 `pnpm run typecheck` 命中 corepack bug → 用 `git push --no-verify`。

## 约定

- **`.cmd` / `.bat` 必须纯 ASCII，注释也不行**：cmd.exe 按字节偏移重读批处理文件，多字节字符会让它失步、把注释碎片当命令执行。校验 `LC_ALL=C grep -c $'[\x80-\xff]' file.cmd` 为 0；中文说明写进 `.md`。
- 清理 `.git/` 陌生残留前审计三件：有没有用户自己的钩子（`.git/hooks` 是否只有 `*.sample`）、全局配置是否设置、该值是否指向工具自己的目标路径。齐了才敢删。
- **改"读取共享资产"的逻辑前先 `grep -rn "<文件名>"` 数消费方**——同一功能的两个出口就是两个 bug 位点，跨层时单侧测试全绿不报警（技能简介英文问题就这么来的）。
- **Windows 上会碰文件系统的测试**：无特权 `symlink()` 报 `EPERM` → 目录链接用 `junction`、**文件**链接用 `fs.link()` 硬链接、`/dev/null` 设备链按平台跳过。**`chmod` 在 NTFS 是空操作**（请求 0o600 读回 0o666=438）→ "owner-only" 是 POSIX-only 断言，加平台守卫（先例 `credentials-local/tests/local.spec.ts`），守卫写在**断言**上而非整个用例上。
- **平台二选一的装配**（预设按 `process.platform` 互斥启用 bash/pwsh 行）会让硬编码工具名与字典序的断言在另一半平台必红 → 抽平台常量 + 对工具名数组 `.sort()`。
- **一个 bundle 的 `cordis.patch.yml` insert 引用的包，必须在该 bundle 的 `package.json` `dependencies` 里**（漏了只在装配时报 `Cannot find package`，类型检查与单测都看不见）。守护用例在 `packages/bundle/base/tests/base.spec.ts`；写这类守护后要**临时摘一条验它会红**。

## 配置 schema（`@deepseek-ai/schemastery`，**不是 zod**）

- **数组字段缺失时填 `[]` 不是 `undefined`** → `config.x ?? DEFAULT` 是死代码；默认值必须由 schema 表达 `z.array(z.string()).default([...DEFAULT])`。探针：缺失 → `[]`；有 `.default` 且缺失 → 默认值；**显式传 `[]` → `[]`**（"传空"与"没传"可区分，是产品语义前提）。
- **没有 `.optional()`**。可选就不写 `.default`，类型标 `?`。
- **`.default(...)` 在模块求值期读常量 → 常量声明必须在 schema 之前**，否则 TDZ。整块（含 JSDoc）前移比改惰性求值干净。
- **值 schema 不支持 object 层 `required: true`**，`required` 只能放 property 内 → "仅部分 branch 需要"的字段在 schema 层标不了必填，要在 `execute` 里手校验抛 `HarnessError`（见 `tool-goal` 的 `refOf`、`tool-jobs` 的 `validateJobId`）。

## 工具注册表与预设

- 唯一请求装配点 `wireSchemas(scope)`（`packages/core/tools/src/index.ts`）。
- **`deferred`（按需）收窄的是"请求体"，不是"可见/可调度/knownNames"**：工具仍注册、仍可 dispatch；`deferred` 沿作用域链 union，`loaded` 只增；`defer()` 对未注册名静默忽略。入口是子入口 **`@deepseek-ai/dsh-tools/search`**（`tool_search`）。
- **工具语义合并走配置项参数化、默认 `split`**：`tool-goal`/`tool-jobs` 的 `toolShape: 'split'|'merged'`、`tool-subagent` 的 `forkProvider`（把 `subagent_fork` 并成 `fork` 布尔）。合并形态注册单工具 + 换分段名（`tool:goal:merged` 等），操作逻辑共享，默认路径零改动。`forkProvider` 配对校验：仅当 fork 侧 `inheritsParentContext === true` 且 primary 侧 `false` 时准入。
- **新增预设同步 4 处**：`presets/<id>/{agent.cordis.yml,preset.yml}`、`agent-presets/src/display.ts` 的 `BUILT_IN_PRESET_KEYS` + `BuiltInPresetCopyKey`、`client/ui-agent-preset/src/client/locales.ts`（en/zh）、`tests/shipped-root.spec.ts` + `apps/cli/tests/web-agent-presets.e2e.ts` 的清单断言。
- 新增分段名还要同步 `system-prompt/src/index.ts` 的 `DEFAULT_SECTION_CATALOG` 与 `localized-sections.ts`。
- 验证 wire 工具名用 `ctx.systemPrompt.assemble({scope})`，**别用 `tools.schemas`**（它把 deferred 当 present 报）。

## 分层技能注册表（`ctx.skills`）

- **provider 名只在层内唯一，跨层按技能名合并**。`SkillLayer.providers` 是 `NamedEntries`（**同层同名直接抛错**）；`collectFresh()` 遍历 `[global, ...chain]` 后 `merged.set(candidate.name, entry)`。所以不同层里两个都叫 `filesystem` 的 provider 都会跑、候选按技能名合并——**不遮蔽**。`SkillRegistry` 类注释里"就近层的同名条目整条胜出"说的是**技能**条目，别按它推 provider 语义（我推错过一次，写了断言去验才发现）。
- 但**第二个实例仍应显式起名**（`config.providerName`）：同层撞名会硬抛错，且 `subagent-codex` README 的约定是"每个已挂载实例需要唯一值"（先例 `isolated` / `codex-primary` / `acp-diagnostic`）。宿主行占 `filesystem`，cordis 预设行用 `cordis-preset`。
- **技能根归属**（已成定论）：**宿主** `skill-filesystem` 行拥有本地发现（`packages/bundle/web-app/cordis.patch.yml:365`，09-09 起），一张宿主行按请求 cwd 服务所有项目；预设只挂**自己目录**的技能，用 `customSkillDirs` + `includeDefaultRoots: false`。预设自带 `skills/` 不会被自动发现——没有代码把 `<预设目录>/skills` 当技能根。
- **`customSkillDirs` 接受 `file:` URL**（`fileURLToPath`）。路径按进程 cwd 解析，而预设会被 `copy()` 到任意目录，"资源在我旁边"只能靠 URL 表达：`customSkillDirs: !!js "[new URL('skills', baseUrl).href]"`（`baseUrl` 就是组合自身的 `file:` URL）。
- **`!!js` 是 scalar 标签**（`vendor/include` 的 `JsExpr`，`kind: 'scalar'`）→ **包裹不了 flow 序列**，`!!js [a, b]` 报 `unknown tag !<tag:yaml.org,2002:js>` 并让整个组合挂载失败；必须写成带引号的字符串让表达式自己求值出数组。

## 文档与生成物

- 中英 README 的 `.i18n.yaml` **逐块比对代码块、必须逐字符一致**——代码块内注释**不能翻译**（报 `code block #N diverges`）。顺序：改文案 → 校验通过 → `tsx scripts/verify-translation-pairing.ts --write <file>` 重记。
- `docs/config-catalog.md`（`gen-config-catalog.ts`）、`docs/tool-catalog.md`（`gen-tool-catalog.ts`，清单在脚本数组里）都是生成物，改完必须重跑并确认 `--check` 报 up to date；**别手改**。

## 技能简介本地化

- **译文归档有两个消费方，改一个必须改另一个**：`tool-skill`（系统提示词 catalog）与 `api/session-controller/src/skill-catalog.ts`（斜杠菜单 / 技能列表 Remote）。只看提示词侧测试全绿、界面侧原样坏着——这就是"有时候还是英文"的形状。两侧现共用 `@deepseek-ai/dsh-skill/translations`（走 **`lib/types/` 的 tsc 产物**做子入口，零 tsdown 配置；主入口保持纯契约不带 `node:fs`）。
- **分层读取**：`<cwd>/.dsh/skill-translations.zh.json` 优先 → `<dshHome>/skill-translations.zh.json` 补缺；合并**逐字段**（`description` 与 `whenToUse` 由不同轮次写入，整条替换会把"补一条"变成"删一条"）。
- **技能名取自 `SKILL.md` frontmatter 的 `name`，不是目录名**（`summarize-1.0.0/` 真名 `summarize`、`ex-skill/` 真名 `create-ex`）；按目录名写键会永久漏译。用户级共享档 `~/.dsh/skill-translations.zh.json` 已有 20 条；**新增技能不会自动有译文**，跑 `/translate-skills`。
- 坏数据：`self-improving-1.2.10` 的 frontmatter `name` 非 kebab-case → 进 catalog 但 `skill` 工具拒绝加载。未修。

## 包入口与子 agent

- **给纯契约包加 IO 子入口**：根 tsdown 默认 entry 固定 4 个名字，新入口要么写包级 `tsdown.config.ts` 多入口，要么让 `exports` 指向 **`lib/types/<name>.js`（tsc 产物）**——后者零配置。配套三件：`files` 加 `lib/types/**/*.js`、`tsconfig.base.json` 加精确 paths、包 tsconfig 加 references。
- **`SystemPrompt.suppressSection(name)`**：表达"这一节在本作用域内不存在"，作用整条作用域链，**不需要替换正文**（与 `section({name})` 同名遮蔽互补，且能抑制本作用域自己注册的分段）。
- **`SubagentStartRequest.allowTools` / `omitSections`**：spawn / fork 支持，acp / out-of-process（dsh-sdk、claude-code、codex）显式拒绝；`applyChildComposition` 顺序 `omitSections` → `allowTools`（翻 `deny`）→ `toolFilter`，顺序有语义。
- **`tools.restrict()` 只作用于继承来的工具**（本作用域自注册的不在其内）且**对未知名字 fail loud**。因此 `allowTools` = 保留名单、未知名**跳过**（写死的白名单在工具集不同的部署上不会炸）；`toolFilter.allow` = 精确控制、名字必须存在。
- 三个功能性子 agent（`command-correct-errors` / `command-summarize-skill` / `command-translate-skills`）默认 `childTools: ['read','write']` + `childOmitSections: ['harness:identity','deployment:persona','deployment:error-lessons']`。**空数组读作"别动它的工具集"**。
- `plan-mode` 的 `section` 是插件内置默认值（`DEFAULT_SECTION`），standard preset 只写 `goalOnApprove: true`——**长文本放插件默认值、部署层只改开关**。

## 技能根归属（**未决**，下次先读这段再动手）

- **代码现状**：宿主 `skill-filesystem` 拥有本地发现。`packages/bundle/web-app/cordis.patch.yml:365` 显式启用它并写明理由（"resolves each request with the session cwd, so one host registration serves different projects"），mtime **09-09**，与 09-09 笔记 `web-skill-catalog-localization`（"Web Host keeps the `skill-filesystem` settings provider enabled even when `tool-skill` remains preset-owned"）、09-12 的 base patch 一致。
- **测试现状**：`apps/cli/tests/web-agent-presets.e2e.ts` 有**两例仍断言"本地发现归预设层"**（`composes the cordis agent with its own toolset` 429 行、`merges the global skill layer ... keeping local discovery preset-side` 514 行），那是 2026-08-09 `layered-skill-registry` 笔记的架构。同侧的其他文件（`apps/web/tests/agent-preset-selection.e2e.ts`、`scaffold-hermetic.e2e.ts` 的注释）也是同一套旧说法，但它们的**代码**（scaffold 用 env + 宿主行 patch 钉根）其实与宿主拥有兼容。
- **缺口**：**全仓没有任何代码把预设自带的 `skills/` 目录挂成技能根**（所有 `join(...,'skills')` 只有 dshHome / agentsHome / project `.dsh|.agents` / `customSkillDirs` / `bundledSkillDir` 五种）→ cordis 预设自带的 `editing-cordis-compositions` 对它自己的 agent **不可达**，而 persona 要求加载它；`snapshots/session/headless.snapshot.ts` 里把 SKILL.md 拷进 `<cwd>/.dsh/skills` 的 fixture 正是绕开这个缺口。**这是待用户决策的点**：改测试对齐宿主拥有（并另补预设技能根），还是把 `skill-filesystem` 行搬回各预设、收窄宿主行。
