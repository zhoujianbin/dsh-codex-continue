# dsh-codex-continue 插件设计文档

> 痛点：Codex 有 5 小时限额，时间一到什么都做不了。目标：做一个 DSH 插件，读取本机 Codex 的项目与会话，选择会话后「在 DSH 里继续」——把 Codex 已做的工作无缝接续到不限时的 DSH 环境。
>
> 本文档基于本机真实数据验证（`~/.codex` 实盘结构、rollout 格式、DSH 插件机制），并附可运行的解析原型（`poc/codex_reader.py`）。

---

## 1. 现状调研结论（已在本机验证）

### 1.1 Codex 数据在哪、长什么样

| 路径 | 内容 | 规模（本机） |
|---|---|---|
| `~/.codex/session_index.jsonl` | 会话索引，每行 `{id, thread_name, updated_at}`，**thread_name 就是人类可读的会话标题** | 204 条 |
| `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | 会话正文，逐行 JSON | 185 个文件 |
| `~/.codex/session_meta` 里的 `cwd` | **项目 = 会话的工作目录** | — |
| `~/.codex/archived_sessions/` | 归档会话 | 少量 |
| `~/.codex/logs_2.sqlite` (608MB) | 新版桌面端日志库 | **不要扫描** |
| `~/.codex/auth.json`、`config.toml` | 凭证/密钥 | **绝不读取** |

**ID 映射已验证**：rollout 文件首行 `session_meta.payload.session_id` 与 `session_index.jsonl` 的 `id` 同一套 ID。**老版本 CLI 的 session_meta 只有 `payload.id` 没有 `session_id`** → 解析器取 `session_id ?? id`（实现于 v0.1，覆盖 2026-06 之前的旧会话）。即：**索引提供标题与时间，rollout 提供正文与项目目录，二者用 session_id 连接**。索引里另有少量条目在本机没有对应 rollout 文件（可能存于新版桌面端 sqlite 或已归档），v1 以 rollout 文件为准、索引作为标题增强。

**rollout 逐行类型**（已抽样验证）：

```jsonl
{"type":"session_meta","payload":{"session_id":"...","cwd":"/Users/jianbinzhou/Documents/...","cli_version":"0.142.3","source":"vscode","model_provider":"openai","base_instructions":"..."}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"...","started_at":...}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":"..."}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{...json}","call_id":"..."}}
{"type":"response_item","payload":{"type":"function_call_output","output":"..."}}
{"type":"turn_context","payload":{...}}
{"type":"world_state","payload":{...}}
```

要点：`content` 是**数组**（`input_text`/`output_text` 部件）；`function_call` 的 `arguments` 是 JSON 字符串；`function_call_output` 的 `output` 可能很大（实测 3KB~18KB），**续作时绝不能原样灌进上下文**。

### 1.2 DSH 插件机制（参照本地已装 `dsh-better-sidebar`，已验证）

- DSH 插件 = 一个 npm 包，**两个半区**：
  - **Host 半区**（Node/Cordis）：`export const name / inject / apply`；可注册 HTTP 前缀路由（`ctx.webServer`）、模型工具（`ctx.tools.register(defineTool(...))`）、服务（`ctx.provide`）、会话投影（`ctx.sessionProjections.register`）。
  - **Client 半区**（浏览器 Web）：以 **CJS + `window.__ModuleLoader__.load({id, factory})`** 注册自身（见 dsh-client-modules 的 Lazy CJS 模型），经 `ctx.inject([...services], cb)` / `ctx.get(...)` 取服务、`ctx.slots.register` 挂 UI；依赖的 client 包在 `package.json` 的 `dsh.client.inject` 里声明。
- **两个必踩的坑**（v0.1 实测）：
  1. **host 读配置**：必须用 `apply(ctx, rawConfig)` 的**第二参数**，读 `ctx.config` 会抛 `cannot get property "config" without inject`，整个 DSH 启动失败。
  2. **client bundle 打包**：必须打成 CJS 并在 banner/footer 里调用 `window.__ModuleLoader__.load` 注册工厂（`tsdown.config.ts`），打成普通 ESM 浏览器侧不会激活（见 `scripts/verify-client-bundle.mjs` 的 VM 回归校验）。
- 安装：`dsh plugin --profile web add <pkg>`（自动写 `dsh.profile.bundles`）；包的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，内含 `- insert: [{id, name, config}]` 挂载行。开发期也可直接改 `~/.dsh/profiles/web/package.json` + `cordis.patch.yml`。
- 本项目机器上 web profile 已装 `@linxin666/dsh-web-ui-all`（内含 dsh-better-sidebar），其 sidechat 服务可注册侧边栏 Tab——续作 UI 可直接复用它的 Tab 注册服务，无需另起炉灶。

---

## 2. 总体架构

一个插件包 `dsh-codex-continue`，双半区：

```
┌──────────────────────── DSH Web (浏览器, client 半区) ────────────────────────┐
│  侧边栏 Tab「Codex 续作」                                                      │
│  ┌───────────┐  ┌───────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ 项目列表   │→ │ 会话列表   │→ │ 会话预览/搜索    │→ │ 操作：继续/交接文档     │  │
│  └───────────┘  └───────────┘  └────────────────┘  └──────────────────────┘  │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ fetch /codex-continue/api/*（过与 /api 相同的 trust fence）
┌───────────────▼──────────────────────────────────────────────────────────────┐
│  dsh-codex-continue (host 半区, Cordis 插件)                                   │
│  ┌──────────────────────────────────────────────────────────────────┐        │
│  │ codexIndex   扫描 + 缓存索引（session_index + rollouts，按 mtime 增量）│        │
│  │ codexParser  rollout JSONL → 规范化会话模型                         │        │
│  │ codexResume  生成「续作包」resume bundle（token 预算内压缩）          │        │
│  │ ctx.webServer  前缀路由 /codex-continue/api/*                       │        │
│  │ ctx.tools     codex 工具（agent 在对话里直接驱动：列项目/列会话/看会话/续作）│        │
│  │ ctx.sessionProjections  'codexResume' 投影（客户端展示已载入的续作包）│        │
│  └──────────────────────────────────────────────────────────────────┘        │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ 只读
┌───────────────▼──────────────────────────────────────────────────────────────┐
│ ~/.codex/session_index.jsonl          ← 索引（标题、时间）                    │
│ ~/.codex/sessions/YYYY/MM/DD/*.jsonl  ← 会话正文                              │
│ 项目 = session_meta.cwd                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

设计原则：
1. **Host 半区自足**——没有 UI 也能用（agent 工具驱动），UI 只是顺手的浏览层。
2. **只读、增量、不进 sqlite**——不碰桌面端 608MB 日志库，只解析 rollout JSONL + 索引。
3. **续作 = 把 Codex 的「现场」折叠成一份有界上下文，交还给 DSH agent**，由 DSH 在同一台机器上继续干活（bash/fs/git 都在）。

---

## 3. 数据层设计

### 3.1 codexIndex（扫描与缓存）

- 启动时（及每次请求触发刷新）扫描 `codexHome/sessions/**/*.jsonl` 与 `session_index.jsonl`。
- 对每个 rollout 读首行 `session_meta`（含 cwd、cli_version、model_provider、时间），从索引按 session_id 取 `thread_name`。
- 缓存到插件数据目录（`~/.dsh/plugin-data/codex-continue/index.json`），按「文件路径 + mtime」判断增量，避免每次全量解析；缓存绑定 `codexHome`（换目录/目录不存在时不会误用旧缓存）。
- **标题兜底**：实测最新一批桌面端会话在索引里没有 `thread_name`（显示为空）→ 标题回退为「第一条有实质内容的 user 消息的前 40 字」，仍无则用 session_id 短形式。
- **索引条目结构**：

```ts
interface CodexSessionIndexEntry {
  sessionId: string;      // 索引 id == rollout session_id
  title?: string;         // thread_name（索引增强）
  cwd: string;            // 项目（来自 session_meta）
  cliVersion: string;
  modelProvider: string;
  startedAt: string;      // 来自 session_meta.timestamp
  updatedAt: string;      // 索引 updated_at 或文件 mtime
  rolloutPath: string;
  archived: boolean;      // 是否在 archived_sessions
  messageCount: number;   // response_item 数量（解析时统计）
}
```

- 项目即 `cwd` 聚合：`project = {cwd, name: basename(cwd), sessionCount, lastUpdatedAt}`。

### 3.2 codexParser（rollout → 规范会话模型）

按行类型折叠成一个有序事件列表，统一结构：

```ts
type CodexEvent =
  | { kind: 'turnStart'; turnId?: string; at?: number }
  | { kind: 'user';     text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; summary: string }
  | { kind: 'tool';     name: string; argsPreview: string; callId?: string }
  | { kind: 'toolResult'; callId?: string; exit?: number | null; tail: string; truncated: boolean }
```

解析细节（全部经真实数据验证）：
- `content` 是部件数组：`input_text` / `output_text` 取 `text` 拼接；**部分版本 `content` 或 `output` 直接是字符串或部件数组**（实测 `function_call_output.output` 两种形态都出现过）→ 解析器必须双形态归一。
- `function_call`：只存 `name` + `arguments` 的前 ~200 字符预览；`arguments` 若为 JSON 则尝试取 `cmd`/路径字段做可读摘要。
- `function_call_output`：用 `output` 里的 `Process exited with code N` 提取退出码；正文只保留尾部 ~500 字符；标记 `truncated`。
- **脚手架过滤**：rollouts 会混入角色为 user/assistant 的系统脚手架消息（`<recommended_plugins>`、`<app-context>`、"You are /root" 等）→ 提取 goal/标题前按标记过滤（见 POC 的 `is_scaffold`）。
- `event_msg.task_started` 作为回合边界；`world_state` / `turn_context` 只记 meta，不进正文。
- 产出两条「文本流」：完整 `transcript`（用于 UI 预览）与压缩版 `compact`（用于续作，见 §4）。

### 3.3 性能与边界

- rollout 单文件实测 ~1000 行，全量解析一次 <100ms；缓存后只增量。
- **不扫描** `logs_2.sqlite`（608MB 桌面日志）；**不读取** `auth.json` / `config.toml`（密钥）。
- 对损坏行（json 解析失败）跳过并计数，不中断整个会话。

---

## 4. 核心：续作机制（resume bundle）

「继续」的实质：**把 Codex 会话折叠成一份有界、决策密集的交接包，注入 DSH 当前会话上下文，DSH agent 据此继续**（同一台机器，cwd 指向原项目，工具链完整）。

### 4.1 Resume bundle 结构

```ts
interface ResumeBundle {
  sessionId: string;
  title: string;
  cwd: string;                      // 原项目目录 —— agent 的 workdir
  model: string;                    // model_provider
  cliVersion: string;
  startedAt: string; updatedAt: string;
  goal: string;                     // 第一条有实质内容的 user 消息（截断 ~1k 字符）
  lastUserMessage: string;          // 最后一条 user 消息全文
  lastAssistantMessage: string;     // 最后一条 assistant 最终消息
  transcript: CompactEvent[];       // 压缩正文（见下）
  stateHints: {                     // 「现场」快照提示
    lastCommands: string[];         // 最后几条 exec_command 的 cmd 预览
    lastExitCodes: number[];
    cwdFilesHint?: string[];        // cwd 下最近改动的文件（可选，需 stat）
  };
  git?: {                           // 可选增强：未提交改动摘要（需在 cwd 跑 git status）
    dirty: boolean;
    summary: string;
  };
}
```

### 4.2 压缩策略（关键）

Codex 会话动辄几百 KB，直接灌上下文必爆。压缩规则（预算可配，默认 `maxBundleTokens ≈ 60k`）：

1. **user 消息**：全量保留（是任务的主线索）。
2. **assistant 最终消息**：全量保留（每回合的结论/交付）。
3. **reasoning**：只留 `summary`（实测 2~91 字符，很省）。
4. **function_call**：压成一行 `▶ exec_command: <cmd 预览>`。
5. **function_call_output**：只留退出码 + 尾部 300~500 字符；**超过预算时优先丢弃**（输出是过程噪音，续作时 agent 可重跑命令拿到全新输出）。
6. **窗口取舍**：预算内按「开头（goal 上下文）+ 最近 N 个回合」保留——开头定目标、结尾定现场，中间过程压缩。
7. 工具调用与其输出**必须成对保留或成对丢弃**，避免孤立的 `toolResult` 悬空（parser 里按 callId 配对）。

### 4.3 三条注入路径

| 路径 | 触发 | 机制 | 适用 |
|---|---|---|---|
| **A. 工具驱动（主路径）** | 用户在 DSH 说「继续 Codex 会话《X》」 | agent 调 `codex resume(session_id)`，bundle 作为**工具结果**直接落入上下文；agent 以 `cwd` 为 workdir 继续 | 最稳、零 UI 依赖 |
| **B. UI 驱动** | 侧边栏选中会话点「继续」 | client 半区把一段预填提示词**注入输入框**（dsh-client-runtime 的 composer 投影能力，不自动发送），用户回车后走路径 A | 浏览场景顺手 |
| **C. 交接文档** | 「生成交接文档」按钮 | host 把 bundle 渲染成 `RESUME.md` 写入项目目录（或复制到剪贴板） | 换 agent / 给人看 / 留档 |

路径 A 是全插件的核心价值。**v0.2 已实现 B（composer 草稿注入）与 C（RESUME.md 写入项目目录）**；路径 B 的「注入输入框」在服务不可用时自动降级为复制到剪贴板。

---

## 5. Host 半区设计

### 5.1 插件骨架

```ts
// src/index.ts（与实现一致）
export const name = 'dsh-codex-continue'
export const inject = ['webServer', 'tools']
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)   // 配置来自第二参数，绝不可读 ctx.config！
  const service = new CodexContinueService(config)
  ctx.provide('codexContinue', service)
  registerRoutes(ctx, service)   // /codex-continue/api/*
  ctx.tools.register(createCodexTool(service))
}
```

### 5.2 REST API（前缀路由，全走只读）

（实现为 **POST-only + 方法名在路径里**，与 dsh-better-sidebar 的 /sidebar/api 同构；每请求过 loopback trust fence：Host-header 为 localhost/127.0.0.1/[::1]，否则 403）

```
POST /codex-continue/api/projects                     → { ok, projects: [{cwd,name,sessionCount,lastUpdatedAt}] }
POST /codex-continue/api/sessions   {query?,project?} → { ok, sessions: [{sessionId,title,cwd,updatedAt,model,messageCount,archived}] }
POST /codex-continue/api/session    {session_id}      → { ok, session: {goal,lastUserMessage,lastAssistantMessage,preview,totalEvents,...} }
POST /codex-continue/api/resume     {session_id}      → { ok, bundle: ResumeBundle }
POST /codex-continue/api/resume-doc {session_id}      → { ok, path } | { ok:false, error }
POST /codex-continue/api/health                       → { ok: true }
```

> 设计期设想的 `pending`（待续作标记）未实现——路径 B 直接注入输入框，不需要中间状态。

### 5.3 codex 工具（agent 可调）

```ts
defineTool({
  name: 'codex',
  description: '读取本机 Codex 项目与会话并继续。action: list_projects / list_sessions / show_session / resume / resume_doc。',
  parameters: { action: enum, query?: string, project?: string, session_id?: string },
  async execute(args, exec) {
    // list_projects: 项目聚合；list_sessions: 按项目/关键词过滤；
    // show_session: 返回规范模型（压缩）；resume: 返回 ResumeBundle，
    //   并在 bundle 里注明 cwd —— agent 据此用 bash workdir 切换；
    // resume_doc: 把 RESUME.md 写入项目目录（v0.2 新增）。
  }
})
```

工具的返回值即上下文注入点：resume 的结果天然进入对话，**无需任何自定义 plumbing**。

### 5.4 会话投影（可选增强）

仿 `dsh-tool-todo` 注册 `codexResume` 投影单元：本会话最近一次 `codex resume` 的 bundle 快照 → 客户端在会话里渲染一张「已载入 Codex 续作包」卡片（显示标题/cwd/token 预算/时间）。

### 5.5 配置（cordis.patch.yml 挂载时注入）

```yaml
- insert:
    - id: codex-continue
      name: 'dsh-codex-continue'
      config:
        codexHome: '~/.codex'               # 默认
        maxBundleTokens: 60000
        toolOutputTail: 400
        argsPreview: 200
        messageMax: 2000
        cacheDir: '~/.dsh/plugin-data/codex-continue'
        includeGitStatus: true
        maxAgeDays: 0
        resumeDocName: 'RESUME.md'          # v0.2
```

---

## 6. Client 半区设计（Web UI）

### 6.1 挂载

- 复用 dsh-better-sidebar 的 `registerTab` 服务注册侧边栏 Tab「Codex 续作」（better-sidebar 已提供该服务，且本机已装）；未装时 client 半区保持静默（工具仍可用）。
- client 半区取服务用 `ctx.inject(['betterSidebar'], cb)`（Codex v0.1 修复，比 `ctx.get` 更规范）；注入输入框走 `ctx.get('conversation')`（懒加载，服务缺失时降级为复制）。
- `package.json`：`dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"]`、`dsh.client.platform: "web"`。

### 6.2 界面与流程

1. **项目列表**：按 cwd 聚合，显示目录名、会话数、最近活动时间；支持搜索。
2. **会话列表**：选中项目后展示会话（标题、时间、模型、消息数）；按 updated_at 倒序；标出归档。
3. **会话预览**：渲染 user / assistant / tool / reasoning 的阅读视图（直接吃 host 的规范模型，前端不重复解析）；顶部显示 cwd 与模型信息。
4. **操作**（v0.2 已实现）：
   - **「⚡ 继续此会话」** → 续作指令**注入当前会话输入框草稿**（`conversation.input.for(scope).setDraft`，不自动发送），回车即走路径 A；注入不可用时自动复制到剪贴板。
   - **「📄 RESUME.md」** → 调 `/resume-doc`，把交接文档写入项目目录并回显路径。
   - **「📋 摘要」** → 复制 goal + 最后消息 + 项目路径的紧凑文本。
   - 列表支持**搜索**（项目/会话两级）、**刷新**、**归档标记**、加载/空/错误状态。

全部数据来自 host REST API，client 半区无状态；可选接入 `codexResume` 投影展示「本会话已载入」。

> 可交互界面原型：`ui-mockup/codex-continue-ui.html`（浏览器直接打开，点着看流程；详见附 B）。

---

## 7. 安全、性能与边界

- **只读**访问 `~/.codex`；绝不读 `auth.json` / `config.toml` / 任何 sqlite（尤其 608MB 的 logs_2.sqlite）。
- 工具输出进上下文前一律截断/降级，防 token 爆炸与敏感信息外泄。
- 索引按 mtime 增量缓存；解析单文件 <100ms。
- 损坏行跳过不中断；并发请求下索引单飞（lazy refresh + 锁）。
- 崩溃安全：缓存写临时文件后原子 rename（或复用 `@deepseek-ai/dsh-atomic-write`）。

---

## 8. 实施步骤

| 阶段 | 内容 | 验收 |
|---|---|---|
| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0（核心）** | host 半区：codexIndex + codexParser + codex 工具（resume）。装进 web profile | ✅ 完成（v0.1） |
| **P1（可用）** | REST API + client 半区：项目/会话列表 + 预览 | ✅ 完成（v0.1） |
| **P2（顺滑）** | 「继续」按钮注入输入框 + RESUME.md 交接文档 + 搜索/刷新/归档标记 | ✅ 完成（v0.2）；会话投影卡片未做（可选） |
| **P3（打磨）** | 全文检索、token 预算配置页、多 profile / 多 codexHome、桌面端 sqlite 只读支持（better-sqlite3，只读打开）、把「继续」升级为打开/新建会话后自动预填 | ⏳ 待做 |
| **发布** | `dsh-codex-continue@0.2.1` 已发布到 npm（2026-08-30），tag `v*` 触发 GitHub Actions 自动发布（需仓库 `NPM_TOKEN` secret） | ✅ 完成（v0.2.1） |

### P0 最小改动路径（不写 UI 也能跑通）
1. 新建 npm 包，按 dsh-better-sidebar 结构搭 host 半区。
2. 实现 index + parser + `codex` 工具（resume 返回 bundle）。
3. 手动改 `~/.dsh/profiles/web/package.json` 的 dependencies + `dsh.profile.bundles`，并往 `cordis.patch.yml` 加 insert 行；重启 dsh web。
4. 在 DSH 会话里直接指挥 agent 调 `codex` 工具续作。

---

## 9. 风险与开放问题

- **新桌面端会话可能不在 rollout 文件里**（索引 20 条无对应文件）→ 后续用只读 sqlite 补齐；v1 明确标注「仅 rollout 可见会话」。
- **续作质量依赖压缩策略**：tool output 丢太多可能让 agent 缺现场 → 保留「最后退出码 + 尾部输出」+ agent 可重跑命令；预算可调。
- **cwd 目录可能已不存在/被移动** → bundle 标注 `cwdExists`，agent 先验证。
- **Codex 版本演进**：rollout schema 若变（新事件类型）→ parser 白名单降级，未知类型存 meta 不崩溃。
- **DSH API 细节**：`ctx.webServer` 前缀路由、`ctx.tools.register`、`ctx.sessionProjections` 的确切签名以 dsh-better-sidebar / dsh-tool-todo / dsh-session-projection 的 README 与类型为准（本文已按其 README 引用）。
- **已踩的坑（v0.1，务必不要再犯）**：① host 读配置必须用 `apply(ctx, rawConfig)` 第二参数，`ctx.config` 会让整个 DSH 启动失败；② client bundle 必须 CJS + `window.__ModuleLoader__.load` 注册，且 client 取服务用 `ctx.inject` 而非裸 `ctx.get`（`get` 只用于懒加载非关键服务）；③ pnpm 11 默认 `minimumReleaseAge=1440`（24h），刚发布的包会拦住 `dsh plugin add/remove`，可等满 24h 或单次命令 `--config.minimumReleaseAge=0`（不要改策略文件）。

---

## 附 B：使用流程（端到端）与界面原型

界面原型：`ui-mockup/codex-continue-ui.html` —— 自包含 HTML，模拟 DSH Web 界面（左：会话列表；中：对话区；右：侧边栏「✦ Codex 续作」Tab），用真实数据做了三个可点击视图（项目列表 → 会话列表 → 会话预览），并演示两条使用路径。浏览器打开即可交互。

### 路径 ① UI 浏览 → 点「继续」

1. DSH 右侧边栏（better-sidebar 区域）切到「✦ Codex 续作」Tab。
2. **项目列表**：按工作目录聚合，显示目录名、会话数、最近活动时间；顶部搜索框。
3. 点项目 → **会话列表**：标题、时间、模型、消息数，倒序。
4. 点会话 → **预览**：goal / 最后 user 消息 / 压缩正文（user、agent、工具、思考分色渲染）。
5. 点「⚡ 继续此会话」→ 预填提示词注入输入框（不自动发送），例如：
   `继续 Codex 会话《设计会话同步工具》(session 019fa261-…)：先 codex resume 看现场，再接着把会话同步工具做下去。`
6. 回车发给 Agent → 走路径 ② 的 agent 侧流程。

### 路径 ② 直接跟 Agent 说（主路径，零 UI）

在任意 DSH 会话里直接说：

```
继续我的 Codex 会话《设计会话同步工具》，先看看现场再接着做。
```

Agent 会：
1. 调 `codex(action: resume, session_id=…)` 工具 → 返回续作包（goal + 最后消息 + 压缩正文 + cwd + 现场提示）；
2. 用续作包的内容向用户复述「目标 / 上次进展 / 现场」；
3. 以 `cwd` 为 workdir 切换到项目目录（bash / fs / git 都在本机），核对 git 状态与最近改动；
4. 接着干活——Codex 做不了的事（超 5h 限额）到这里无缝接续。

### 路径 ③ 交接文档

点「📄 交接文档」或让 agent 生成 → host 把续作包渲染成 `RESUME.md` 写入项目目录（或复制到剪贴板），用于换 agent / 给人看 / 跨机迁移（续作包本身是便携 JSON，天然支持「迁移到另一台电脑」这个原始诉求）。

---

## 附 A：POC（poc/codex_reader.py）

见同目录 `poc/codex_reader.py`：零依赖 Python 实现 §3 的索引 + 解析 + resume bundle 预览。已在 `~/.codex` 真实数据上跑通：

```
== 项目（cwd 聚合，共 28 个 / 202 个会话）==
• /Users/jianbinzhou/ob/ob_note  (144 会话)
• /Users/jianbinzhou/Documents/appellate-copilot  (10 会话)
• /Users/jianbinzhou/code/上地学区房雷达  (6 会话)
• /Users/jianbinzhou/Documents/营销数字员工项目  (6 会话)
...

$ python3 poc/codex_reader.py 设计会话同步工具
- [设计会话同步工具] 2026-07-27T07:02 · openai · msgs=12 · cli=0.146.0-alpha.3.1
== Resume bundle 预览：设计会话同步工具 ==
cwd      : /Users/jianbinzhou/Documents/Codex/2026-07-27/co-d
goal     : 你现在每个会话，是用什么格式存的，我想做一个会话同步的工具，把当前的会话能完整的迁移到另一台电脑上
lastUser : “项目”里的会话，和非项目里的会话，有区别么
lastAgent: 有区别，但区别主要在“归属和工作目录元数据”，会话正文格式完全一样。…
compact  :
  user: 你现在每个会话，是用什么格式存的…
  ▶ exec_command: {"cmd":"sed -n '1,240p' /Users/jianbinzhou/.agents/skills/session-logs-1.0.0/SKILL.md",...}
    └ exit=0 tail=…
```
