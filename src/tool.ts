import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CodexContinueService } from './service.ts'

/**
 * The model-facing `codex` tool: browse local Codex projects/sessions and
 * resume one session. `resume` returns the full ResumeBundle as the tool
 * result — that is the context-injection point for continuing the session
 * in DSH.
 */
interface LooseToolOptions {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => unknown
  }
  execute: (
    args: Record<string, unknown>,
    exec: { signal?: { throwIfAborted(): void }; agent?: unknown },
  ) => Promise<Record<string, unknown>>
}

export function createCodexTool(service: CodexContinueService) {
  // dsh-tools' strict output-schema inference chokes on this tool's dynamic
  // per-action union return; the schema is runtime-valid and the registry
  // accepts the resulting definition either way.
  const options: LooseToolOptions = {
    name: 'codex',
    description:
      'Read local OpenAI Codex projects and sessions (~/.codex, read-only) and continue a session in DSH. ' +
      'Actions: list_projects (projects grouped by working directory), list_sessions (filter by query/project), ' +
      'show_session (goal + last messages + preview), resume (full resume bundle: goal, last messages, ' +
      'compact transcript, cwd, git status — switch your workdir to the returned cwd and continue the work), ' +
      'resume_doc (write a RESUME.md handoff document into the project directory).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list_projects', 'list_sessions', 'show_session', 'resume', 'resume_doc'],
        description: 'Which operation to perform.',
      },
      query: {
        type: 'string',
        description: 'Optional keyword for list_sessions: matches session title, cwd or id.',
      },
      project: {
        type: 'string',
        description: 'Optional cwd filter for list_sessions (exact or substring match).',
      },
      session_id: {
        type: 'string',
        description: 'Session id (required for show_session / resume).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          error: { type: 'string' },
          path: { type: 'string' },
          projects: { type: 'json' },
          sessions: { type: 'json' },
          session: { type: 'json' },
          bundle: { type: 'json' },
        },
      },
      render: (_args, value: unknown) => {
        const text = renderSummary(value as unknown as ToolResult)
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.()
      const action = args['action'] as string
      await service.refresh()
      switch (action) {
        case 'list_projects': {
          return { ok: true, action, projects: service.listProjects() }
        }
        case 'list_sessions': {
          const sessions = service
            .listSessions({ query: args['query'] as string | undefined, project: args['project'] as string | undefined })
            .map((s) => ({
              sessionId: s.sessionId,
              title: s.title ?? null,
              cwd: s.cwd,
              updatedAt: s.updatedAt ?? null,
              model: s.modelProvider ?? null,
              messageCount: s.messageCount,
              archived: s.archived,
            }))
          return { ok: true, action, sessions }
        }
        case 'show_session': {
          const sessionId = args['session_id'] as string
          if (!sessionId) throw new Error('codex: session_id is required for show_session')
          const d = service.detail(sessionId)
          if (!d) throw new Error(`codex: session not found: ${sessionId}`)
          return {
            ok: true,
            action,
            session: {
              sessionId: d.entry.sessionId,
              title: d.entry.title ?? null,
              cwd: d.entry.cwd,
              model: d.entry.modelProvider ?? null,
              startedAt: d.entry.startedAt ?? null,
              updatedAt: d.entry.updatedAt ?? null,
              goal: d.goal.slice(0, 1000),
              lastUserMessage: d.lastUserMessage.slice(0, 1500),
              lastAssistantMessage: d.lastAssistantMessage.slice(0, 1500),
              totalEvents: d.totalEvents,
              preview: d.preview,
            },
          }
        }
        case 'resume': {
          const sessionId = args['session_id'] as string
          if (!sessionId) throw new Error('codex: session_id is required for resume')
          const bundle = await service.resume(sessionId)
          if (!bundle) throw new Error(`codex: session not found: ${sessionId}`)
          return { ok: true, action, bundle }
        }
        case 'resume_doc': {
          const sessionId = args['session_id'] as string
          if (!sessionId) throw new Error('codex: session_id is required for resume_doc')
          const doc = await service.writeResumeDoc(sessionId)
          return { ok: doc.ok, action, path: doc.path, error: doc.error ?? undefined }
        }
        default:
          throw new Error(`codex: unknown action ${action}`)
      }
    },
  }
  return defineTool(options as never)
}

interface ToolResult {
  ok: boolean
  action: string
  projects?: { cwd: string; name: string; sessionCount: number; lastUpdatedAt?: string }[]
  sessions?: { title: string | null; cwd: string; updatedAt: string | null; messageCount: number }[]
  session?: { title: string | null; cwd: string; goal: string; lastUserMessage: string; lastAssistantMessage: string }
  bundle?: {
    title: string
    cwd: string
    cwdExists: boolean
    goal: string
    git?: { dirty: boolean; summary: string } | null
    stats: { totalEvents: number; compactEvents: number; estimatedTokens: number; truncated: boolean }
  }
  path?: string
  error?: string
}

function renderSummary(v: ToolResult): string {
  if (!v.ok) return `codex failed: ${v.error ?? 'unknown error'}`
  const head = []
  if (v.action === 'list_projects') {
    const projects = v.projects ?? []
    head.push(`Codex 项目（${projects.length} 个，按工作目录聚合）:`)
    for (const p of projects.slice(0, 20)) {
      head.push(`  • ${p.name}  (${p.cwd})  · ${p.sessionCount} 会话`)
    }
  } else if (v.action === 'list_sessions') {
    const sessions = v.sessions ?? []
    head.push(`Codex 会话（${sessions.length} 个）:`)
    for (const s of sessions.slice(0, 30)) {
      head.push(`  • [${s.title ?? '(无标题)'}] ${s.cwd} · ${s.updatedAt ?? ''} · ${s.messageCount} msgs`)
    }
  } else if (v.action === 'show_session') {
    const s = v.session!
    head.push(`会话《${s.title ?? '(无标题)'}》 cwd=${s.cwd}`)
    if (s.goal) head.push(`goal: ${s.goal}`)
    if (s.lastUserMessage) head.push(`lastUser: ${s.lastUserMessage}`)
    if (s.lastAssistantMessage) head.push(`lastAgent: ${s.lastAssistantMessage}`)
  } else if (v.action === 'resume') {
    const b = v.bundle!
    head.push(`Codex 续作包《${b.title}》已载入（${b.stats.estimatedTokens} tokens / ${b.stats.compactEvents} 条）`)
    head.push(`cwd: ${b.cwd} (${b.cwdExists ? '存在' : '不存在！先验证目录'})`)
    if (b.goal) head.push(`goal: ${b.goal}`)
    if (b.git) head.push(`git: ${b.git.summary.slice(0, 200)}`)
    if (b.stats.truncated) head.push(`⚠ 会话较长，正文已按预算截断，聚焦最近进展`)
    head.push(`请切到 cwd 目录核对现场后继续。完整正文在返回值的 bundle.transcript 里。`)
  } else if (v.action === 'resume_doc') {
    if (v.path) head.push(`已生成交接文档: ${v.path}`)
    else head.push(`交接文档生成失败: ${v.error ?? 'unknown error'}`)
  }
  return head.join('\n')
}
