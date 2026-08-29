import { CodexIndex } from './codex-index.ts'
import { parseRollout } from './codex-parser.ts'
import { buildResumeBundle, type ResumeOptions } from './resume-builder.ts'
import type { CodexContinueConfig, CodexEvent, CodexProject, CodexSessionIndex, ResumeBundle } from './types.ts'

/**
 * Facade the tool and the REST routes share. Single source of truth for
 * "list / show / resume" over the Codex data.
 */
export interface SessionDetail {
  entry: CodexSessionIndex
  goal: string
  lastUserMessage: string
  lastAssistantMessage: string
  /** Events capped for UI preview (last `previewLimit`, text trimmed). */
  preview: { kind: string; text: string }[]
  totalEvents: number
  corruptLines: number
}

export class CodexContinueService {
  readonly index: CodexIndex

  constructor(private config: CodexContinueConfig) {
    this.index = new CodexIndex({
      codexHome: config.codexHome,
      cacheDir: config.cacheDir,
      maxAgeDays: config.maxAgeDays,
    })
  }

  private resumeOpts(): ResumeOptions {
    return {
      maxBundleTokens: this.config.maxBundleTokens,
      toolOutputTail: this.config.toolOutputTail,
      argsPreview: this.config.argsPreview,
      messageMax: this.config.messageMax,
      includeGitStatus: this.config.includeGitStatus,
    }
  }

  async refresh(force = false): Promise<void> {
    await this.index.refresh(force)
  }

  listProjects(): CodexProject[] {
    return this.index.listProjects()
  }

  listSessions(filter?: { project?: string; query?: string }): CodexSessionIndex[] {
    let sessions = this.index.listSessions()
    if (filter?.project) {
      const p = filter.project
      sessions = sessions.filter((s) => s.cwd === p || s.cwd.includes(p))
    }
    if (filter?.query) {
      const q = filter.query.toLowerCase()
      sessions = sessions.filter((s) =>
        (s.title ?? '').toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q),
      )
    }
    return sessions.slice(0, 200)
  }

  getSession(sessionId: string): CodexSessionIndex | undefined {
    return this.index.getSession(sessionId)
  }

  /** Full parse of one session's rollout. */
  readSession(sessionId: string): { entry: CodexSessionIndex; events: CodexEvent[] } | undefined {
    const entry = this.index.getSession(sessionId)
    if (!entry || entry.broken) return undefined
    try {
      const { meta, events, corruptLines } = parseRollout(entry.rolloutPath)
      // cwd may have been empty at scan time; prefer fresh meta
      const merged: CodexSessionIndex = entry.cwd === '(unknown)' && meta.cwd ? { ...entry, cwd: meta.cwd } : entry
      return { entry: merged, events }
    } catch {
      return undefined
    }
  }

  detail(sessionId: string, previewLimit = 120): SessionDetail | undefined {
    const read = this.readSession(sessionId)
    if (!read) return undefined
    const { entry, events } = read
    const preview = events.slice(-previewLimit).map((e) => ({ kind: e.kind, text: previewText(e) }))
    return {
      entry,
      goal: readGoal(events),
      lastUserMessage: lastUser(events),
      lastAssistantMessage: lastAssistant(events),
      preview,
      totalEvents: events.length,
      corruptLines: 0,
    }
  }

  async resume(sessionId: string): Promise<ResumeBundle | undefined> {
    const read = this.readSession(sessionId)
    if (!read) return undefined
    return buildResumeBundle(read.entry, read.events, this.resumeOpts())
  }
}

import { goalOf, lastAssistantMessageOf, lastUserMessageOf } from './codex-parser.ts'

const readGoal = goalOf
const lastUser = lastUserMessageOf
const lastAssistant = lastAssistantMessageOf

function previewText(e: CodexEvent): string {
  switch (e.kind) {
    case 'user':
    case 'assistant':
      return e.text.slice(0, 800)
    case 'reasoning':
      return e.summary.slice(0, 300)
    case 'tool':
      return (e.argsPreview ?? '').slice(0, 200)
    case 'toolResult':
      return e.tail.slice(0, 300)
    default:
      return ''
  }
}
