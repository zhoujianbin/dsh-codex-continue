import { CodexContinueService } from '../lib/index.js'
import { writeResumeMarkdown } from '../lib/resume-builder.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const service = new CodexContinueService({
  codexHome: process.env.HOME + '/.codex',
  maxBundleTokens: 60000, toolOutputTail: 400, argsPreview: 200, messageMax: 2000,
  cacheDir: process.env.HOME + '/.dsh/plugin-data/codex-continue',
  includeGitStatus: true, maxAgeDays: 0, resumeDocName: 'RESUME.md',
})
await service.refresh(true)
const sessions = service.listSessions()
const target = sessions.find((s) => s.title === '设计会话同步工具')
if (!target) { console.log('session not found'); process.exit(0) }

// service.writeResumeDoc writes into the real project cwd; here we render to
// a temp dir to demonstrate the document without touching the project.
const bundle = await service.resume(target.sessionId)
const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-continue-smoke-'))
const file = await writeResumeMarkdown(dir, 'RESUME.md', bundle)
const md = await readFile(file, 'utf8')
console.log('written:', file)
console.log('--- RESUME.md (前 40 行) ---')
console.log(md.split('\n').slice(0, 40).join('\n'))
