import { describe, expect, it } from 'vitest'
import {
  exitCodeOf,
  goalOf,
  isScaffold,
  lastAssistantMessageOf,
  lastUserMessageOf,
  normalizeText,
  parseRolloutText,
} from '../src/codex-parser.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FIXTURE = fileURLToPath(new URL('./fixtures/codex-home/sessions/2026/07/27/rollout-test1.jsonl', import.meta.url))

describe('parseRolloutText', () => {
  const raw = readFileSync(FIXTURE, 'utf8')

  it('captures session_meta fields', () => {
    const { meta } = parseRolloutText(raw)
    expect(meta.sessionId).toBe('sess-111')
    expect(meta.cwd).toBe('/tmp/proj-a')
    expect(meta.cliVersion).toBe('0.146.0-alpha.3.1')
    expect(meta.modelProvider).toBe('openai')
  })

  it('normalizes message content arrays and drops empty', () => {
    const { events } = parseRolloutText(raw)
    const users = events.filter((e) => e.kind === 'user')
    expect(users.length).toBe(2)
    expect(users[0]!.text).toContain('会话同步')
    expect(events.filter((e) => e.kind === 'assistant').length).toBe(1)
    expect(events.filter((e) => e.kind === 'turnStart').length).toBe(1)
  })

  it('parses function_call / function_call_output incl. array-shaped output', () => {
    const { events } = parseRolloutText(raw)
    const tools = events.filter((e) => e.kind === 'tool')
    const results = events.filter((e) => e.kind === 'toolResult')
    expect(tools.length).toBe(1)
    expect(tools[0]!.name).toBe('exec_command')
    expect(tools[0]!.callId).toBe('call-1')
    expect(results.length).toBe(2)
    expect(results[0]!.exit).toBe(0)
    expect(results[1]!.exit).toBe(1) // array-shaped output normalized
    expect(results[1]!.tail).toContain('array-shaped output')
  })

  it('counts corrupt lines without throwing', () => {
    const { corruptLines } = parseRolloutText(raw)
    expect(corruptLines).toBe(1)
  })
})

describe('goal & scaffold filtering', () => {
  const { events } = parseRolloutText(readFileSync(FIXTURE, 'utf8'))

  it('goal = first substantive user message (scaffold skipped)', () => {
    expect(goalOf(events)).toContain('会话同步')
    expect(goalOf(events)).not.toContain('recommended_plugins')
  })

  it('lastUser / lastAssistant are scaffold-filtered', () => {
    expect(lastUserMessageOf(events)).toContain('会话同步')
    expect(lastAssistantMessageOf(events)).toContain('rollout JSONL')
    expect(isScaffold('<recommended_plugins> stuff')).toBe(true)
    expect(isScaffold('正常消息')).toBe(false)
  })
})

describe('helpers', () => {
  it('exitCodeOf extracts exit codes', () => {
    expect(exitCodeOf('Process exited with code 42\nOutput: x')).toBe(42)
    expect(exitCodeOf('no exit marker')).toBeNull()
  })

  it('normalizeText handles string / array / null', () => {
    expect(normalizeText('abc')).toBe('abc')
    expect(normalizeText([{ type: 'input_text', text: 'a' }, { type: 'output_text', text: 'b' }])).toBe('ab')
    expect(normalizeText(null)).toBe('')
  })
})
