/**
 * dsh-codex-continue client half — a "Codex 续作" tab in the right sidebar.
 *
 * Registers into dsh-better-sidebar's `ctx.betterSidebar.registerTab`
 * service when present; without better-sidebar the plugin still works
 * through the `codex` tool (this half just stays silent).
 *
 * The tab talks to the host half through POST /codex-continue/api/* (the
 * same loopback-fenced prefix route the tool uses).
 *
 * v0.2: "继续此会话" injects the instruction into the current conversation's
 * composer draft (via ctx.get('conversation')), and "RESUME.md" writes the
 * handoff document into the project directory.
 * v0.2.1: theme-aware colors (DSH --dsw-alias-* tokens with dark fallbacks)
 * so the panel stays legible in light themes; projects show the full
 * directory path + session count, sessions show title + model + message
 * count so the two can never be confused.
 */
import { createElement as h, useEffect, useState } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'

export const name = 'dsh-codex-continue'
export const inject = [] as const

// Minimal structural types of the services we consume — no build-time
// dependency on dsh-better-sidebar or the conversation package.
interface TabDescriptorLike {
  id: string
  title: string
  component: (props: unknown) => ReactNode
}
interface BetterSidebarLike {
  registerTab(descriptor: TabDescriptorLike): () => void
  isTabEnabled?(id: string): boolean
}
interface ClientContext {
  betterSidebar: BetterSidebarLike
  inject(services: string[], callback: (ctx: ClientContext) => void): unknown
  effect(fn: () => void | (() => void)): void
}

export function apply(ctx: ClientContext): void {
  // Keep the root plugin active even when better-sidebar is absent. The child
  // scope activates as soon as that optional service appears.
  ctx.inject(['betterSidebar'], (scope) => {
    scope.effect(() => scope.betterSidebar.registerTab({ id: 'codex-continue', title: 'Codex 续作', component: CodexTab }))
  })
}

// ── Structural faces for the current session + composer draft ─────────────

interface SessionScope { sessionId: string; cwd?: string }
interface SessionInput {
  state: { getSnapshot(): { draft: string } }
  setDraft(text: string): void
}
interface ConversationLike {
  input: { for(actx: unknown): SessionInput }
}
interface TabCtxLike {
  sessions?: { scope(sessionId: string): unknown }
  get<T = unknown>(key: string): T | undefined
}
interface TabPropsLike {
  ctx: TabCtxLike
  scope: SessionScope
  tab: unknown
  visible: boolean
}

/** Append text to the current session's composer draft; false when unavailable. */
function appendToDraft(ctx: TabCtxLike, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions?.scope(sessionId)
    if (!actx) return false
    const conversation = ctx.get<ConversationLike>('conversation')
    if (!conversation) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? text : draft + ' ' + text)
    return true
  } catch {
    return false
  }
}

// ── Data types ────────────────────────────────────────────────────────────

interface Project { cwd: string; name: string; sessionCount: number; lastUpdatedAt?: string }
interface Session {
  sessionId: string; title: string | null; cwd: string; updatedAt: string | null
  model: string | null; messageCount: number; archived: boolean
}
interface PreviewMsg { kind: string; text: string }
interface SessionDetail {
  sessionId: string; title: string | null; cwd: string; model: string | null; cliVersion: string | null
  goal: string; lastUserMessage: string; lastAssistantMessage: string; totalEvents: number; preview: PreviewMsg[]
}

async function api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch('/codex-continue/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()) as T
}

// ── Theme-aware styles (DSH --dsw-alias-* tokens, dark fallbacks) ─────────
// Using the theme variables keeps the panel legible in light AND dark themes.

const C = {
  text: 'var(--dsw-alias-label-primary, #e8eaed)',
  text2: 'var(--dsw-alias-label-secondary, #9aa3ad)',
  text3: 'var(--dsw-alias-label-tertiary, #7a8494)',
  dim: 'var(--dsw-alias-label-dimmed, #6b7480)',
  bg: 'var(--dsw-alias-bg-base, #141619)',
  bg1: 'var(--dsw-alias-bg-layer-1, #1b1e23)',
  bg2: 'var(--dsw-alias-bg-layer-2, #22262c)',
  border: 'var(--dsw-alias-border-l1, #262a31)',
  border2: 'var(--dsw-alias-border-l2, #31363f)',
  brand: 'var(--dsw-alias-brand-primary, #5b8cff)',
  brandInvert: 'var(--dsw-alias-brand-primary-invert, #0f1420)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.10))',
  error: 'var(--dsw-alias-state-error-primary, #e5534b)',
  warn: 'var(--dsw-alias-state-warn-label, #e2b93b)',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
}

const S = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', fontSize: 12.5, color: C.text, fontFamily: '-apple-system,"PingFang SC","Microsoft YaHei",sans-serif' },
  hdr: { padding: '8px 10px', borderBottom: '1px solid ' + C.border, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  hdrTitle: { fontWeight: 600, fontSize: 13 },
  hint: { padding: '6px 10px 0', fontSize: 10.5, color: C.dim, flexShrink: 0 },
  back: { cursor: 'pointer', color: C.text2, fontSize: 15, border: 'none', background: 'none', padding: '0 2px' },
  iconBtn: { cursor: 'pointer', background: 'none', border: '1px solid ' + C.border2, borderRadius: 6, color: C.text2, fontSize: 12, padding: '2px 7px', marginLeft: 'auto' },
  search: { margin: '8px 10px 4px', padding: '6px 9px', background: C.bg1, border: '1px solid ' + C.border2, borderRadius: 8, color: C.text, fontSize: 12.5, outline: 'none', flexShrink: 0 },
  list: { flex: 1, overflowY: 'auto' as const, padding: 6 },
  item: { padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid transparent' },
  row1: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  name: { fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 },
  meta: { fontSize: 11, color: C.text2, marginTop: 3, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  path: { fontFamily: C.mono, fontSize: 10.5, color: C.text3, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  badge: { fontSize: 10, padding: '1px 6px', borderRadius: 4, background: C.bg2, color: C.text2, border: '1px solid ' + C.border2, flexShrink: 0 },
  badgeModel: { color: C.brand, borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #5b8cff) 45%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #5b8cff) 14%, transparent)' },
  badgeArchived: { color: C.warn, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warn-label, #e2b93b) 45%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-label, #e2b93b) 14%, transparent)' },
  count: { color: C.text2, fontSize: 11, marginLeft: 'auto', flexShrink: 0 },
  pmeta: { fontSize: 11, color: C.text2, fontFamily: C.mono, border: '1px solid ' + C.border, background: C.bg1, borderRadius: 8, padding: '8px 10px', margin: '8px 10px 0', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, maxHeight: 130, overflowY: 'auto' as const, flexShrink: 0 },
  pbody: { flex: 1, overflowY: 'auto' as const, padding: '8px 10px 10px', display: 'flex', flexDirection: 'column' as const, gap: 6 },
  pmsg: { borderRadius: 8, padding: '7px 10px', fontSize: 11.5, border: '1px solid ' + C.border, background: C.bg1, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const, color: C.text },
  pmsgUser: { background: C.bg2, borderColor: C.border2 },
  lbl: { display: 'block', fontSize: 10, color: C.dim, marginBottom: 2 },
  actions: { borderTop: '1px solid ' + C.border, padding: 10, display: 'flex', gap: 8, flexShrink: 0 },
  btn: { flex: 1, textAlign: 'center' as const, padding: '8px 4px', borderRadius: 8, border: '1px solid ' + C.border2, background: C.bg2, color: C.text, fontSize: 12, cursor: 'pointer' },
  primary: { background: C.brand, borderColor: C.brand, color: C.brandInvert, fontWeight: 600 },
  toast: { margin: '0 10px 10px', padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3, #2a2f37)', border: '1px solid ' + C.border2, fontSize: 11.5, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, maxHeight: 90, overflowY: 'auto' as const, flexShrink: 0, color: C.text },
  note: { padding: '14px 12px', color: C.dim, fontSize: 11.5, lineHeight: 1.7, textAlign: 'center' as const },
  err: { padding: '10px 12px', color: C.error, fontSize: 11.5, lineHeight: 1.6 },
}

function CodexTab(props: unknown): ReactElement {
  const tabProps = props as TabPropsLike
  const [view, setView] = useState<'projects' | 'sessions' | 'preview'>('projects')
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const loadProjects = () => {
    setLoading(true)
    setErr('')
    api<{ projects: Project[] }>('projects')
      .then((r) => setProjects(r.projects))
      .catch((e) => setErr('扫描失败：' + String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    api<{ projects: Project[] }>('projects')
      .then((r) => alive && setProjects(r.projects))
      .catch((e) => alive && setErr('扫描失败：' + String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])

  const openProject = (cwd: string) => {
    setProject(cwd)
    setQuery('')
    setLoading(true)
    setErr('')
    api<{ sessions: Session[] }>('sessions', { project: cwd })
      .then((r) => { setSessions(r.sessions); setView('sessions') })
      .catch((e) => setErr('加载失败：' + String(e)))
      .finally(() => setLoading(false))
  }

  const openSession = (id: string) => {
    setLoading(true)
    setErr('')
    api<{ session: SessionDetail }>('session', { session_id: id })
      .then((r) => { setDetail(r.session); setView('preview') })
      .catch((e) => setErr('加载失败：' + String(e)))
      .finally(() => setLoading(false))
  }

  const back = () => {
    if (view === 'sessions') { setView('projects'); setQuery('') }
    else setView('sessions')
  }

  const continueSession = () => {
    if (!detail) return
    const title = detail.title ?? detail.sessionId
    const text = '继续 Codex 会话《' + title + '》(session ' + detail.sessionId + ')：先 codex resume 看现场，再继续做。'
    if (appendToDraft(tabProps.ctx, tabProps.scope.sessionId, text)) {
      setMsg('已填入下方输入框，回车发送即可。')
    } else {
      navigator.clipboard?.writeText(text).catch(() => {})
      setMsg('未能注入输入框，已复制指令，粘贴到对话里发送：\n\n' + text)
    }
  }

  const writeResumeDoc = () => {
    if (!detail) return
    setMsg('正在生成交接文档…')
    api<{ ok: boolean; path?: string; error?: string }>('resume-doc', { session_id: detail.sessionId })
      .then((r) => {
        if (r.ok && r.path) setMsg('已生成：' + r.path)
        else setMsg('生成失败：' + (r.error ?? 'unknown'))
      })
      .catch((e) => setMsg('生成失败：' + String(e)))
  }

  const copySummary = () => {
    if (!detail) return
    const text =
      'Codex 会话《' + (detail.title ?? detail.sessionId) + '》\n' +
      'cwd: ' + detail.cwd +
      (detail.goal ? '\ngoal: ' + detail.goal.slice(0, 300) : '') +
      (detail.lastUserMessage ? '\nlastUser: ' + detail.lastUserMessage.slice(0, 300) : '')
    navigator.clipboard?.writeText(text).catch(() => {})
    setMsg('已复制会话摘要')
  }

  const q = query.trim().toLowerCase()

  if (view === 'projects') {
    const shown = q ? projects.filter((p) => (p.name + ' ' + p.cwd).toLowerCase().includes(q)) : projects
    return h('div', { style: S.root }, [
      h('div', { style: S.hdr }, [
        h('span', null, '📂'),
        h('span', { style: S.hdrTitle }, 'Codex 项目'),
        h('span', { style: S.badge }, String(projects.length) + ' 个目录'),
        h('button', { style: S.iconBtn, onClick: loadProjects, title: '重新扫描' }, '⟳'),
      ]),
      h('div', { style: S.hint }, '📁 = 项目目录（Codex 会话的工作目录），点击进入查看会话'),
      h('input', { style: S.search, placeholder: '🔍 搜索项目 / 路径…', value: query, onChange: (e: { target: { value: string } }) => setQuery(e.target.value) }),
      err ? h('div', { style: S.err }, err) : null,
      loading && projects.length === 0 ? h('div', { style: S.note }, '扫描 ~/.codex …') : null,
      projects.length === 0 && !loading && !err ? h('div', { style: S.note }, '未发现 Codex 会话（检查 ~/.codex/sessions）') : null,
      h('div', { style: S.list },
        shown.map((p) =>
          h('div', {
            key: p.cwd, style: S.item,
            onClick: () => openProject(p.cwd),
            onMouseEnter: (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = C.hover },
            onMouseLeave: (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'none' },
          },
            h('div', { style: S.row1 }, [
              h('span', { style: { fontSize: 14 } }, '📁'),
              h('span', { style: S.name }, p.name),
              h('span', { style: S.count }, p.sessionCount + ' 会话'),
            ]),
            h('div', { style: S.meta }, [
              h('span', { style: S.path }, p.cwd),
              p.lastUpdatedAt ? h('span', { style: { marginLeft: 'auto', color: C.dim } }, '最近 ' + p.lastUpdatedAt.slice(0, 10)) : null,
            ]),
          ),
        ),
      ),
    ])
  }

  if (view === 'sessions') {
    const shown = q ? sessions.filter((s) => ((s.title ?? '') + ' ' + s.cwd).toLowerCase().includes(q)) : sessions
    return h('div', { style: S.root }, [
      h('div', { style: S.hdr }, [
        h('button', { style: S.back, onClick: back }, '‹'),
        h('span', { style: { fontFamily: C.mono, fontSize: 11, color: C.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project),
      ]),
      h('div', { style: S.hint }, '💬 = 单个会话，点击查看详情 / 继续'),
      h('input', { style: S.search, placeholder: '🔍 搜索会话…', value: query, onChange: (e: { target: { value: string } }) => setQuery(e.target.value) }),
      err ? h('div', { style: S.err }, err) : null,
      sessions.length === 0 && !loading && !err ? h('div', { style: S.note }, '该项目下没有会话') : null,
      h('div', { style: S.list },
        shown.map((s) =>
          h('div', { key: s.sessionId, style: S.item, onClick: () => openSession(s.sessionId) },
            h('div', { style: S.row1 }, [
              h('span', { style: { fontSize: 13 } }, '💬'),
              h('span', { style: S.name }, s.title ?? '(无标题)'),
              s.archived ? h('span', { style: { ...S.badge, ...S.badgeArchived } }, '归档') : null,
              h('span', { style: S.badgeModel }, s.model ?? 'openai'),
            ]),
            h('div', { style: S.meta }, [
              h('span', null, (s.updatedAt ?? '').slice(0, 16)),
              h('span', null, s.messageCount + ' msgs'),
            ]),
          ),
        ),
      ),
    ])
  }

  // preview
  return h('div', { style: S.root }, [
    h('div', { style: S.hdr }, [
      h('button', { style: S.back, onClick: back }, '‹'),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, detail?.title ?? ''),
    ]),
    detail ? [
      h('div', { style: S.pmeta },
        'cwd: ' + detail.cwd +
        (detail.goal ? '\ngoal: ' + detail.goal.slice(0, 300) : '') +
        (detail.lastUserMessage ? '\nlastUser: ' + detail.lastUserMessage.slice(0, 200) : '')),
      h('div', { style: S.pbody },
        detail.preview.map((m, i) =>
          h('div', { key: i, style: { ...S.pmsg, ...(m.kind === 'user' ? S.pmsgUser : {}) } },
            [h('span', { style: S.lbl }, kindLabel(m.kind)), m.text.slice(0, 500)],
          ),
        ),
      ),
      msg ? h('div', { style: S.toast }, msg) : null,
      h('div', { style: S.actions }, [
        h('button', { style: { ...S.btn, ...S.primary }, onClick: continueSession }, '⚡ 继续此会话'),
        h('button', { style: S.btn, onClick: writeResumeDoc }, '📄 RESUME.md'),
        h('button', { style: S.btn, onClick: copySummary }, '📋 摘要'),
      ]),
    ] : h('div', { style: S.note }, '加载中…'),
  ])
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'user': return '你'
    case 'assistant': return 'Codex'
    case 'tool': return '工具'
    case 'toolResult': return '输出'
    case 'reasoning': return '思考'
    default: return kind
  }
}
