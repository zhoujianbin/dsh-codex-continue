import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CodexContinueService } from './service.ts'

/**
 * REST API under /codex-continue/api. POST-only, method encoded in the path
 * (same shape as dsh-better-sidebar's /sidebar/api). Every request passes a
 * loopback trust fence.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<void> | void

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Minimal trust fence: only loopback Host headers reach the API. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? ''
  if (LOOPBACK_HOSTS.has(host)) return true
  // IPv6 literal Host like [::1]:3080
  const bracket = /^\[([0-9a-f:]+)\]$/.exec(host)
  return bracket ? LOOPBACK_HOSTS.has(bracket[1]!) : false
}

export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(body)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

export function registerCodexRoutes(ctx: { webServer: { register(r: unknown): unknown } }, service: CodexContinueService): void {
  const handlers: Record<string, Handler> = {
    projects: async (_req, res) => {
      await service.refresh()
      writeJson(res, 200, { ok: true, projects: service.listProjects() })
    },
    sessions: async (_req, res, body) => {
      await service.refresh()
      const sessions = service
        .listSessions({
          query: typeof body['query'] === 'string' ? body['query'] : undefined,
          project: typeof body['project'] === 'string' ? body['project'] : undefined,
        })
        .map((s) => ({
          sessionId: s.sessionId,
          title: s.title ?? null,
          cwd: s.cwd,
          updatedAt: s.updatedAt ?? null,
          model: s.modelProvider ?? null,
          messageCount: s.messageCount,
          archived: s.archived,
        }))
      writeJson(res, 200, { ok: true, sessions })
    },
    session: async (_req, res, body) => {
      const id = typeof body['session_id'] === 'string' ? body['session_id'] : undefined
      if (!id) return writeJson(res, 400, { ok: false, error: 'session_id required' })
      const d = service.detail(id)
      if (!d) return writeJson(res, 404, { ok: false, error: 'session not found' })
      writeJson(res, 200, {
        ok: true,
        session: {
          sessionId: d.entry.sessionId,
          title: d.entry.title ?? null,
          cwd: d.entry.cwd,
          model: d.entry.modelProvider ?? null,
          cliVersion: d.entry.cliVersion ?? null,
          startedAt: d.entry.startedAt ?? null,
          updatedAt: d.entry.updatedAt ?? null,
          goal: d.goal.slice(0, 1000),
          lastUserMessage: d.lastUserMessage.slice(0, 1500),
          lastAssistantMessage: d.lastAssistantMessage.slice(0, 1500),
          totalEvents: d.totalEvents,
          preview: d.preview,
        },
      })
    },
    resume: async (_req, res, body) => {
      const id = typeof body['session_id'] === 'string' ? body['session_id'] : undefined
      if (!id) return writeJson(res, 400, { ok: false, error: 'session_id required' })
      const bundle = await service.resume(id)
      if (!bundle) return writeJson(res, 404, { ok: false, error: 'session not found' })
      writeJson(res, 200, { ok: true, bundle })
    },
    health: async (_req, res) => {
      writeJson(res, 200, { ok: true })
    },
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/codex-continue/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/codex-continue/api/')
        ? pathname.slice('/codex-continue/api/'.length)
        : undefined
      if (!method || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }
      const handler = handlers[method]
      if (!handler) {
        writeJson(res, 404, { ok: false, error: 'unknown method' })
        return
      }
      try {
        const body = await readJsonBody(req)
        await handler(req, res, body)
      } catch (err) {
        writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'bad request' })
      }
    },
  })
}
