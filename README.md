# dsh-codex-continue

> DSH 插件：读取本机 OpenAI Codex 的项目与会话，在 DSH 里无缝「继续」——Codex 5 小时限额到了，活不丢，换个环境接着干。

在 DSH（[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)）里浏览你的 Codex 历史会话（`~/.codex/sessions/*.jsonl`，**只读**），选中任意会话后生成一份「续作包」——目标 + 最后消息 + 压缩正文 + 项目目录 + git 状态——交给 DSH agent，让它以原工作目录为基准继续完成 Codex 没做完的工作。

## 特性

- 📂 **项目/会话浏览**：按工作目录聚合项目，标题（来自 `session_index.jsonl`）、时间、模型、消息数一目了然；支持搜索
- 🔎 **会话预览**：goal / 最后消息 / 分色正文（你 / Codex / 思考 / 工具调用）
- ⚡ **续作包 resume bundle**：token 预算内压缩正文（工具输出截尾、reasoning 只留摘要、按 callId 配对），附 `cwd` 存在性与 `git status`
- ✍️ **一键继续**：侧边栏点「⚡ 继续此会话」直接把续作指令注入输入框（不再需要复制粘贴）；「📄 RESUME.md」在项目目录生成交接文档（换 agent / 给人看 / 跨机迁移都可用）
- 🧰 **两种用法**：直接在对话里指挥 agent 调 `codex` 工具（主路径），或侧边栏「Codex 续作」Tab 浏览后点继续（需 dsh-better-sidebar）
- 🔍 **浏览体验**：项目/会话搜索、刷新、归档标记、goal/最后消息预览
- 🔒 **安全**：只读 rollout JSONL + 索引；绝不读 `auth.json` / `config.toml` / sqlite

## 安装

```bash
# 在运行 DSH web 的机器上
dsh plugin --profile web add dsh-codex-continue
# 重启 dsh web 生效
```

侧边栏 UI 需要 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（没有也能用——`codex` 工具始终可用）。

## 使用

### 方式一：直接跟 Agent 说（推荐）

```
继续我的 Codex 会话《设计会话同步工具》，先看看现场再接着做。
```

Agent 会调 `codex(action: resume)` 拉回续作包，切到原项目目录核对现场后继续。

### 方式二：侧边栏浏览

右侧边栏 →「✦ Codex 续作」Tab → 项目 → 会话 → 预览 →「⚡ 继续此会话」（把续作指令复制到剪贴板）。

### `codex` 工具

| action | 说明 |
|---|---|
| `list_projects` | 按工作目录聚合的项目列表 |
| `list_sessions` | 会话列表（`query` / `project` 过滤） |
| `show_session` | goal + 最后消息 + 预览片段 |
| `resume` | 完整续作包（目标/正文/cwd/git/统计），即上下文注入点 |
| `resume_doc` | 在项目目录生成 `RESUME.md` 交接文档 |

## 配置

`cordis.patch.yml` 的 `config` 块（或 profile 的 patch 层覆盖）：

| key | 默认 | 说明 |
|---|---|---|
| `codexHome` | `~/.codex` | Codex 数据目录 |
| `maxBundleTokens` | 60000 | 续作包正文 token 预算 |
| `toolOutputTail` | 400 | 工具输出保留尾部字符数 |
| `argsPreview` | 200 | 工具参数预览长度 |
| `messageMax` | 2000 | 单条消息在正文中的字符上限 |
| `includeGitStatus` | true | 续作时跑 `git status` |
| `maxAgeDays` | 0 | 只列出最近 N 天的会话（0=全部） |
| `resumeDocName` | `RESUME.md` | 交接文档文件名（写入项目目录） |

## 数据来源（只读）

- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` —— 会话正文（JSONL 事件流）
- `~/.codex/session_index.jsonl` —— 标题/时间索引（`id` 与 rollout 的 `session_id` 同键）
- 项目 = 会话的 `cwd`

## 开发

```bash
pnpm install
pnpm test        # vitest（解析/索引/续作包）
pnpm typecheck
pnpm build       # tsc host + tsdown client bundle
```

> 客户端 bundle 注意事项：client 半区必须以 **CJS + `window.__ModuleLoader__.load({id, factory})`** 形式打包注册（见 `tsdown.config.ts` 的 banner/footer），否则浏览器侧不会激活；`build` 末尾的 `verify-client-bundle.mjs` 会在 VM 里模拟加载器做回归校验。host 半区读配置必须用 `apply(ctx, rawConfig)` 的第二参数，不能读 `ctx.config`。

设计文档见 [DESIGN.md](DESIGN.md)；可交互界面原型见 [ui-mockup/](ui-mockup/)；解析原型见 [poc/](poc/)。

## License

MIT
