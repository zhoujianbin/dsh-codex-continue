import { describe, expect, it } from 'vitest'
import {
  buildResumeBundle,
  compactTranscript,
  estimateTokens,
  stateHintsOf,
} from '../src/resume-builder.ts'
import type { CodexEvent, CodexSessionIndex } from '../src/types.ts'

const events: CodexEvent[] = [
  { kind: 'turnStart', turnId: 't1' },
  { kind: 'user', text: '帮我做一个会话同步工具，把会话完整迁移到另一台电脑' },
  { kind: 'reasoning', summary: '先看存储格式' },
  { kind: 'tool', name: 'exec_command', argsPreview: '{"cmd":"find ~/.codex"}', callId: 'c1' },
  { kind: 'toolResult', callId: 'c1', exit: 0, tail: '~/.codex/sessions', truncated: false },
  { kind: 'assistant', text: '已确认 rollout JSONL 格式。' },
  { kind: 'user', text: '项目会话和非项目会话有区别么' },
  { kind: 'assistant', text: '正文格式完全一样，只差元数据。' },
]

describe('estimateTokens', () => {
  it('is a monotonic char-based estimate', () => {
    expect(estimateTokens('abc')).toBe(2)
    expect(estimateTokens('你好世界')).toBe(3)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('compactTranscript', () => {
  it('pairs tool call with its result', () => {
    const { lines } = compactTranscript(events, { toolOutputTail: 400, argsPreview: 200, messageMax: 2000 }, 10_000)
    const joined = lines.join('\n')
    expect(joined).toContain('▶ exec_command')
    expect(joined).toContain('exit=0')
    expect(joined).toContain('user: 帮我做一个会话同步工具')
    expect(joined).toContain('agent: 正文格式完全一样')
  })

  it('respects a tiny budget by keeping only the tail', () => {
    const { lines, truncated } = compactTranscript(events, { toolOutputTail: 400, argsPreview: 200, messageMax: 2000 }, 20)
    expect(truncated).toBe(true)
    expect(lines.length).toBeLessThan(events.length)
  })

  it('drops scaffold user messages from the transcript', () => {
    const withScaffold: CodexEvent[] = [
      { kind: 'user', text: '<recommended_plugins> here is a list' },
      { kind: 'assistant', text: 'real answer' },
    ]
    const { lines } = compactTranscript(withScaffold, { toolOutputTail: 400, argsPreview: 200, messageMax: 2000 }, 10_000)
    expect(lines.join('\n')).not.toContain('recommended_plugins')
  })
})

describe('stateHintsOf', () => {
  it('collects last commands and exit codes', () => {
    const hints = stateHintsOf(events)
    expect(hints.lastCommands[0]).toContain('find ~/.codex')
    expect(hints.lastExitCodes).toEqual([0])
  })
})

describe('buildResumeBundle', () => {
  it('builds a bundle with goal, messages and stats (missing cwd tolerated)', async () => {
    const entry: CodexSessionIndex = {
      sessionId: 'sess-111',
      title: '设计会话同步工具',
      cwd: '/tmp/definitely-not-exists-dsh-codex-continue-test',
      rolloutPath: '/nope.jsonl',
      archived: false,
      messageCount: 4,
    }
    const bundle = await buildResumeBundle(entry, events, {
      maxBundleTokens: 60_000,
      toolOutputTail: 400,
      argsPreview: 200,
      messageMax: 2000,
      includeGitStatus: true,
    })
    expect(bundle.title).toBe('设计会话同步工具')
    expect(bundle.goal).toContain('会话同步')
    expect(bundle.cwdExists).toBe(false)
    expect(bundle.git).toBeNull()
    expect(bundle.transcript.length).toBeGreaterThan(0)
    expect(bundle.stats.totalEvents).toBe(events.length)
  })
})
