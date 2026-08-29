/**
 * dsh-codex-continue client half — a "Codex 续作" tab in the right sidebar.
 *
 * Registers into dsh-better-sidebar's `ctx.betterSidebar.registerTab`
 * service when present; without better-sidebar the plugin still works
 * through the `codex` tool (this half just stays silent).
 *
 * The tab talks to the host half through POST /codex-continue/api/* (the
 * same loopback-fenced prefix route the tool uses).
 */
import { createElement as h, useEffect, useState } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'

export const name = 'dsh-codex-continue'
export const inject = [] as const

// Minimal structural types of the better-sidebar service we consume — we do
// NOT depend on the dsh-better-sidebar package at build time.
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

// ── UI ────────────────────────────────────────────────────────────────────

interface Project { cwd: string; name: string; sessionCount: number; lastUpdatedAt?: string }
interface Session { sessionId: string; title: string | null; cwd: string; updatedAt: string | null; model: string | null; messageCount: number }
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

const S = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', fontSize: 12, color: '#e8eaed' },
  hdr: { padding: '10px 12px', borderBottom: '1px solid #262a31', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
  back: { cursor: 'pointer', color: '#9aa3ad', fontSize: 15, border: 'none', background: 'none' },
  search: { margin: '10px 12px 4px', padding: '7px 10px', background: '#1b1e23', border: '1px solid #31363f', borderRadius: 8, color: '#9aa3ad', fontSize: 12 },
  list: { flex: 1, overflowY: 'auto' as const, padding: 6 },
  item: { padding: '9px 10px', borderRadius: 8, cursor: 'pointer' },
  name: { fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  meta: { fontSize: 11, color: '#6b7480', marginTop: 3, display: 'flex', gap: 8 },
  badge: { fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#ffffff14', color: '#9aa3ad', border: '1px solid #31363f' },
  pmeta: { fontSize: 11, color: '#6b7480', fontFamily: 'ui-monospace,Menlo,monospace', border: '1px solid #262a31', background: '#1b1e23', borderRadius: 8, padding: '8px 10px', margin: '10px 12px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const },
  pbody: { flex: 1, overflowY: 'auto' as const, padding: '0 12px 10px', display: 'flex', flexDirection: 'column' as const, gap: 6 },
  pmsg: { borderRadius: 8, padding: '7px 10px', fontSize: 11.5, border: '1px solid #262a31', background: '#1b1e23', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
  lbl: { display: 'block', fontSize: 10, color: '#6b7480', marginBottom: 2 },
  actions: { borderTop: '1px solid #262a31', padding: 10, display: 'flex', gap: 8 },
  btn: { flex: 1, textAlign: 'center' as const, padding: '8px 4px', borderRadius: 8, border: '1px solid #31363f', background: '#22262c', color: '#e8eaed', fontSize: 12, cursor: 'pointer' },
  primary: { background: '#5b8cff', borderColor: '#5b8cff', color: '#0f1420', fontWeight: 600 },
  toast: { margin: '0 12px 10px', padding: '8px 10px', borderRadius: 8, background: '#2a2f37', border: '1px solid #3c424d', fontSize: 11.5, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const },
  note: { padding: '10px 12px', color: '#6b7480', fontSize: 11, lineHeight: 1.6 },
}

function CodexTab(_props: unknown): ReactElement {
  const [view, setView] = useState<'projects' | 'sessions' | 'preview'>('projects')
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [project, setProject] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    api<{ projects: Project[] }>('projects')
      .then((r) => alive && setProjects(r.projects))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [])

  const openProject = (cwd: string) => {
    setProject(cwd)
    setLoading(true)
    api<{ sessions: Session[] }>('sessions', { project: cwd })
      .then((r) => { setSessions(r.sessions); setView('sessions') })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false))
  }

  const openSession = (id: string) => {
    setLoading(true)
    api<{ session: SessionDetail }>('session', { session_id: id })
      .then((r) => { setDetail(r.session); setView('preview') })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false))
  }

  const back = () => {
    if (view === 'sessions') setView('projects')
    else setView('sessions')
  }

  const continueSession = async () => {
    if (!detail) return
    const text =
      '继续 Codex 会话《' + (detail.title ?? detail.sessionId) + '》(session ' + detail.sessionId + ')：先 codex resume 看现场，再继续做。'
    try {
      await navigator.clipboard.writeText(text)
      setMsg('已复制续作指令到剪贴板，粘贴到对话里发给 Agent：\n\n' + text)
    } catch {
      setMsg('请手动复制这段指令发给 Agent：\n\n' + text)
    }
  }

  const copySummary = () => {
    if (!detail) return
    const text =
      'Codex 会话《' + (detail.title ?? detail.sessionId) + '》\ncwd: ' + detail.cwd +
      (detail.goal ? '\ngoal: ' + detail.goal.slice(0, 300) : '') +
      (detail.lastUserMessage ? '\nlastUser: ' + detail.lastUserMessage.slice(0, 300) : '')
    navigator.clipboard.writeText(text).catch(() => {})
    setMsg('已复制会话摘要')
  }

  if (view === 'projects') {
    return h('div', { style: S.root }, [
      h('div', { style: S.hdr }, [h('span', null, '📂'), h('span', null, 'Codex 项目'), h('span', { style: S.badge }, String(projects.length))]),
      err ? h('div', { style: S.note }, '加载失败：' + err) : null,
      loading && projects.length === 0 ? h('div', { style: S.note }, '扫描 ~/.codex …') : null,
      h('div', { style: S.list },
        projects.map((p) =>
          h('div', { key: p.cwd, style: S.item, onClick: () => openProject(p.cwd), onMouseEnter: (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = '#ffffff0a' }, onMouseLeave: (e: MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'none' } },
            h('div', { style: S.name }, '📁 ' + p.name),
            h('div', { style: S.meta }, [h('span', null, p.sessionCount + ' 会话'), h('span', null, (p.lastUpdatedAt ?? '').slice(0, 10)), h('span', { style: { marginLeft: 'auto' } }, '›')]),
          ),
        ),
      ),
    ])
  }

  if (view === 'sessions') {
    return h('div', { style: S.root }, [
      h('div', { style: S.hdr }, [h('button', { style: S.back, onClick: back }, '‹'), h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11, color: '#6b7480', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project)]),
      h('div', { style: S.list },
        sessions.map((s) =>
          h('div', { key: s.sessionId, style: S.item, onClick: () => openSession(s.sessionId) },
            h('div', { style: S.name }, '💬 ' + (s.title ?? '(无标题)')),
            h('div', { style: S.meta }, [h('span', null, (s.updatedAt ?? '').slice(0, 16)), h('span', { style: S.badge }, s.model ?? 'openai'), h('span', null, s.messageCount + ' msgs')]),
          ),
        ),
      ),
    ])
  }

  // preview
  return h('div', { style: S.root }, [
    h('div', { style: S.hdr }, [h('button', { style: S.back, onClick: back }, '‹'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail?.title ?? '')]),
    detail ? [
      h('div', { style: S.pmeta },
        'cwd: ' + detail.cwd +
        (detail.goal ? '\ngoal: ' + detail.goal.slice(0, 300) : '') +
        (detail.lastUserMessage ? '\nlastUser: ' + detail.lastUserMessage.slice(0, 200) : '')),
      h('div', { style: S.pbody },
        detail.preview.map((m, i) =>
          h('div', { key: i, style: { ...S.pmsg, ...(m.kind === 'user' ? { background: '#22262c', borderColor: '#31363f' } : {}) } },
            [h('span', { style: S.lbl }, kindLabel(m.kind)), m.text.slice(0, 500)],
          ),
        ),
      ),
      msg ? h('div', { style: S.toast }, msg) : null,
      h('div', { style: S.actions }, [
        h('button', { style: { ...S.btn, ...S.primary }, onClick: continueSession }, '⚡ 继续此会话'),
        h('button', { style: S.btn, onClick: copySummary }, '📋 复制摘要'),
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
