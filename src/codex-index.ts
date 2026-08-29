import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseRollout } from './codex-parser.ts'
import type { CodexProject, CodexSessionIndex } from './types.ts'

/**
 * Scans ~/.codex for sessions and joins the human-readable index.
 *
 * Data sources:
 *   - rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   - title index:  ~/.codex/session_index.jsonl  {id, thread_name, updated_at}
 * The rollout's session_meta.session_id is the join key.
 *
 * Read-only: never touches auth.json / config.toml / *.sqlite.
 */

interface CacheFile {
  version: number
  codexHome: string
  entries: CodexSessionIndex[]
}

const CACHE_VERSION = 1

/** Read session_index.jsonl into id -> row. */
function readTitleIndex(codexHome: string): Map<string, { thread_name?: string; updated_at?: string }> {
  const map = new Map<string, { thread_name?: string; updated_at?: string }>()
  const file = path.join(codexHome, 'session_index.jsonl')
  if (!fs.existsSync(file)) return map
  const raw = fs.readFileSync(file, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const id = o['id'] as string | undefined
      if (!id) continue
      map.set(id, {
        thread_name: (o['thread_name'] as string) ?? undefined,
        updated_at: (o['updated_at'] as string) ?? undefined,
      })
    } catch {
      // skip corrupt index lines
    }
  }
  return map
}

export interface IndexOptions {
  codexHome: string
  cacheDir: string
  maxAgeDays: number
}

export class CodexIndex {
  private entries = new Map<string, CodexSessionIndex>()
  private projectOrder: string[] = []
  private lastError: string | null = null
  private scannedAt = 0

  constructor(private opts: IndexOptions) {}

  get lastScanError(): string | null {
    return this.lastError
  }

  get scannedAtMs(): number {
    return this.scannedAt
  }

  /** All sessions, newest first. */
  listSessions(): CodexSessionIndex[] {
    return [...this.entries.values()].sort((a, b) =>
      (b.updatedAt ?? b.startedAt ?? '').localeCompare(a.updatedAt ?? a.startedAt ?? ''),
    )
  }

  /** Projects aggregated by cwd, sorted by session count then name. */
  listProjects(): CodexProject[] {
    const byCwd = new Map<string, CodexSessionIndex[]>()
    for (const e of this.entries.values()) {
      const cwd = e.cwd || '(unknown)'
      const arr = byCwd.get(cwd) ?? []
      arr.push(e)
      byCwd.set(cwd, arr)
    }
    return [...byCwd.entries()]
      .map(([cwd, sessions]) => ({
        cwd,
        name: path.basename(cwd) || cwd,
        sessionCount: sessions.length,
        lastUpdatedAt: sessions
          .map((s) => s.updatedAt ?? s.startedAt ?? '')
          .filter(Boolean)
          .sort()
          .at(-1),
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name))
  }

  getSession(sessionId: string): CodexSessionIndex | undefined {
    return this.entries.get(sessionId)
  }

  /** Refresh the index. Cheap first pass: only reads session_meta + index. */
  async refresh(force = false): Promise<void> {
    const { codexHome, cacheDir, maxAgeDays } = this.opts
    const cachePath = path.join(cacheDir, 'index.json')
    const sessionsRoot = path.join(codexHome, 'sessions')

    if (!force && this.scannedAt > 0 && Date.now() - this.scannedAt < 30_000) {
      return // coalesce bursts
    }

    // Try loading the cache first, then check freshness by file mtimes.
    let cached: CacheFile | null = null
    if (!force && fs.existsSync(cachePath)) {
      try {
        cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CacheFile
      } catch {
        cached = null
      }
    }

    const titleIndex = readTitleIndex(codexHome)
    const files: { file: string; archived: boolean }[] = []
    if (fs.existsSync(sessionsRoot)) {
      files.push(...walkRolloutFiles(sessionsRoot).map((f) => ({ file: f, archived: false })))
    }
    const archivedRoot = path.join(codexHome, 'archived_sessions')
    if (fs.existsSync(archivedRoot)) {
      files.push(...walkRolloutFiles(archivedRoot).map((f) => ({ file: f, archived: true })))
    }

    // Freshness check: if every file's mtime is covered by the cache, reuse it.
    // The cache is bound to its codexHome, and a missing sessions root never
    // reuses a stale cache (that would resurrect sessions of another home).
    if (cached && cached.version === CACHE_VERSION && cached.codexHome === codexHome && fs.existsSync(sessionsRoot)) {
      const cachedByPath = new Map(cached.entries.map((e) => [e.rolloutPath, e]))
      let fresh = true
      for (const { file } of files) {
        const existing = cachedByPath.get(file)
        if (!existing || existing.messageCount <= 0) {
          fresh = false
          break
        }
        try {
          const mtime = (await fsp.stat(file)).mtimeMs
          if (existing.updatedAt && new Date(existing.updatedAt).getTime() < mtime - 1000) {
            fresh = false
            break
          }
        } catch {
          fresh = false
          break
        }
      }
      if (fresh) {
        this.entries = new Map(cached.entries.map((e) => [e.sessionId, e]))
        this.scannedAt = Date.now()
        return
      }
    }

    // Full scan.
    const entries: CodexSessionIndex[] = []
    for (const { file, archived } of files) {
      try {
        const { meta, events } = parseRollout(file)
        if (!meta.sessionId || !meta.cwd) {
          entries.push({ sessionId: path.basename(file), cwd: '(unknown)', rolloutPath: file, archived, messageCount: 0, broken: true })
          continue
        }
        const idxRow = titleIndex.get(meta.sessionId)
        const updatedAt = idxRow?.updated_at ?? lastMtime(file)
        entries.push({
          sessionId: meta.sessionId,
          title: idxRow?.thread_name,
          cwd: meta.cwd,
          cliVersion: meta.cliVersion,
          modelProvider: meta.modelProvider,
          startedAt: meta.timestamp,
          updatedAt,
          rolloutPath: file,
          archived,
          messageCount: events.filter((e) => e.kind === 'user' || e.kind === 'assistant').length,
        })
      } catch {
        // unreadable file: skip
      }
    }

    this.entries = new Map(entries.map((e) => [e.sessionId, e]))
    this.scannedAt = Date.now()

    // Persist cache (best-effort, atomic-ish).
    try {
      await fsp.mkdir(cacheDir, { recursive: true })
      const cache: CacheFile = { version: CACHE_VERSION, codexHome, entries }
      const tmp = cachePath + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(cache))
      await fsp.rename(tmp, cachePath)
    } catch {
      // cache is an optimization; never fail the scan for it
    }
  }
}

function walkRolloutFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const full = path.join(dir, name)
      let st: fs.Stats
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(full)
      else if (st.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(full)
    }
  }
  return out
}

function lastMtime(file: string): string | undefined {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString()
  } catch {
    return undefined
  }
}
