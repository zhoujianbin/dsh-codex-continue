import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexIndex } from '../src/codex-index.ts'

const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/codex-home', import.meta.url))

async function freshIndex(cacheDir: string) {
  const index = new CodexIndex({ codexHome: FIXTURE_HOME, cacheDir, maxAgeDays: 0 })
  await index.refresh()
  return index
}

describe('CodexIndex', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-continue-'))

  it('indexes rollouts and joins titles from session_index.jsonl', async () => {
    const index = await freshIndex(cacheDir)
    const sessions = index.listSessions()
    expect(sessions.length).toBe(2)
    const s1 = index.getSession('sess-111')!
    expect(s1.title).toBe('设计会话同步工具')
    expect(s1.cwd).toBe('/tmp/proj-a')
    expect(s1.messageCount).toBe(3) // 2 user + 1 assistant
  })

  it('aggregates projects by cwd', async () => {
    const index = await freshIndex(cacheDir)
    const projects = index.listProjects()
    expect(projects.length).toBe(2)
    const projA = projects.find((p) => p.cwd === '/tmp/proj-a')!
    expect(projA.sessionCount).toBe(1)
  })

  it('reuses the cache on a second refresh', async () => {
    const index = await freshIndex(cacheDir)
    const first = index.listSessions().length
    // second refresh with force=false should hit the cache path
    await index.refresh()
    expect(index.listSessions().length).toBe(first)
  })

  it('tolerates a missing codex home', async () => {
    const index = new CodexIndex({ codexHome: '/tmp/does-not-exist-xyz', cacheDir, maxAgeDays: 0 })
    await index.refresh()
    expect(index.listSessions().length).toBe(0)
    expect(index.listProjects().length).toBe(0)
  })
})
