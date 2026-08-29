import { CodexContinueService } from '../lib/index.js'

const service = new CodexContinueService({
  codexHome: process.env.HOME + '/.codex',
  maxBundleTokens: 60000,
  toolOutputTail: 400,
  argsPreview: 200,
  messageMax: 2000,
  cacheDir: process.env.HOME + '/.dsh/plugin-data/codex-continue',
  includeGitStatus: true,
  maxAgeDays: 0,
})

await service.refresh(true)
const projects = service.listProjects()
console.log('项目数:', projects.length)
console.log('前 5 项目:')
for (const p of projects.slice(0, 5)) console.log('  •', p.name, p.cwd, p.sessionCount, '会话', p.lastUpdatedAt ?? '')

const sessions = service.listSessions()
console.log('会话总数:', sessions.length)
console.log('最近 5 个:')
for (const s of sessions.slice(0, 5)) console.log('  -', s.title ?? '(无标题)', s.cwd, s.updatedAt ?? '')

// 找设计会话同步工具
const target = sessions.find((s) => s.title === '设计会话同步工具')
if (!target) { console.log('未找到目标会话'); process.exit(0) }
console.log('目标会话:', target.sessionId, target.cwd)

const d = service.detail(target.sessionId)
console.log('goal:', d?.goal.slice(0, 80))
console.log('lastUser:', d?.lastUserMessage.slice(0, 60))
console.log('totalEvents:', d?.totalEvents, 'preview 条数:', d?.preview.length)

const bundle = await service.resume(target.sessionId)
console.log('=== resume bundle ===')
console.log('title:', bundle?.title)
console.log('cwd:', bundle?.cwd, 'cwdExists:', bundle?.cwdExists)
console.log('git:', bundle?.git ? JSON.stringify(bundle.git).slice(0, 150) : 'null')
console.log('stats:', JSON.stringify(bundle?.stats))
console.log('transcript 前 6 行:')
for (const l of bundle?.transcript.slice(0, 6) ?? []) console.log('  ', l.slice(0, 110))
