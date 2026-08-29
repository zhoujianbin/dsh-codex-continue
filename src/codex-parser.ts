import fs from 'node:fs'
import type { CodexEvent, CodexSessionIndex } from './types.ts'

/**
 * Rollout JSONL parsing. Each line is one event:
 *   session_meta / event_msg / response_item / turn_context / world_state
 * response_item payloads carry the conversation: message (user/assistant/
 * developer), reasoning, function_call, function_call_output.
 */

/** System-scaffold markers that pollute goal/title extraction. */
const SCAFFOLD_MARKERS = [
  'recommended_plugins',
  'Codex desktop context',
  'multi_agent_mode',
  "You are `/root`",
  'You are Codex, a coding agent',
  'You are Codex, a highly capable',
  '<app-context>',
]

/** True for messages that are system scaffolding, not real conversation. */
export function isScaffold(text: string): boolean {
  const head = text.slice(0, 200)
  return SCAFFOLD_MARKERS.some((m) => head.includes(m))
}

/** Normalize a `content` / `output` field that may be a string or an array of parts. */
export function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((p) => (typeof p === 'string' ? p : (p as { text?: unknown })?.text ?? ''))
      .filter((s) => typeof s === 'string')
      .join('')
  }
  if (value == null) return ''
  return String(value)
}

/** Extract "Process exited with code N" from a tool output tail. */
export function exitCodeOf(output: string): number | null {
  const m = /Process exited with code (\d+)/.exec(output)
  return m ? Number(m[1]) : null
}

export interface RolloutParseResult {
  meta: {
    sessionId?: string
    cwd?: string
    cliVersion?: string
    modelProvider?: string
    timestamp?: string
  }
  events: CodexEvent[]
  /** Lines skipped because JSON.parse failed. */
  corruptLines: number
}

/**
 * Parse one rollout JSONL file into normalized events.
 * Never throws on corrupt lines — they are counted and skipped.
 */
export function parseRollout(path: string): RolloutParseResult {
  const raw = fs.readFileSync(path, 'utf8')
  return parseRolloutText(raw)
}

/** Parse rollout text (exposed for tests). */
export function parseRolloutText(raw: string): RolloutParseResult {
  const meta: RolloutParseResult['meta'] = {}
  const events: CodexEvent[] = []
  let corruptLines = 0

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      corruptLines += 1
      continue
    }
    const type = obj['type']
    const payload = (obj['payload'] ?? {}) as Record<string, unknown>

    if (type === 'session_meta') {
      // Newer CLI versions carry session_id; older ones only have id.
      meta.sessionId = (payload['session_id'] as string) ?? (payload['id'] as string) ?? undefined
      meta.cwd = (payload['cwd'] as string) ?? undefined
      meta.cliVersion = (payload['cli_version'] as string) ?? undefined
      meta.modelProvider = (payload['model_provider'] as string) ?? undefined
      meta.timestamp = (payload['timestamp'] as string) ?? undefined
    } else if (type === 'event_msg' && payload['type'] === 'task_started') {
      events.push({ kind: 'turnStart', turnId: payload['turn_id'] as string, at: payload['started_at'] as number })
    } else if (type === 'response_item') {
      const pt = payload['type']
      if (pt === 'message') {
        const role = payload['role']
        const text = normalizeText(payload['content']).trim()
        if (text) {
          if (role === 'user') events.push({ kind: 'user', text })
          else if (role === 'assistant') events.push({ kind: 'assistant', text })
          // developer/system messages are instructions, not conversation
        }
      } else if (pt === 'reasoning') {
        const summary = normalizeText(payload['summary']).trim()
        if (summary) events.push({ kind: 'reasoning', summary })
      } else if (pt === 'function_call') {
        const args = normalizeText(payload['arguments']).trim()
        events.push({
          kind: 'tool',
          name: (payload['name'] as string) ?? 'unknown',
          argsPreview: args,
          callId: (payload['call_id'] as string) ?? undefined,
        })
      } else if (pt === 'function_call_output') {
        const output = normalizeText(payload['output'])
        events.push({
          kind: 'toolResult',
          callId: (payload['call_id'] as string) ?? undefined,
          exit: exitCodeOf(output),
          tail: output.slice(-400),
          truncated: output.length > 400,
        })
      }
      // other response_item types (e.g. local_shell_call) are ignored
    }
    // turn_context / world_state are metadata; not conversation
  }

  return { meta, events, corruptLines }
}

/** First substantive user message (scaffold-filtered) — the session "goal". */
export function goalOf(events: CodexEvent[]): string {
  for (const e of events) {
    if (e.kind === 'user' && !isScaffold(e.text)) return e.text
  }
  return ''
}

/** Last substantive user message (scaffold-filtered). */
export function lastUserMessageOf(events: CodexEvent[]): string {
  let last = ''
  for (const e of events) {
    if (e.kind === 'user' && !isScaffold(e.text)) last = e.text
  }
  return last
}

/** Last assistant final message (scaffold-filtered). */
export function lastAssistantMessageOf(events: CodexEvent[]): string {
  let last = ''
  for (const e of events) {
    if (e.kind === 'assistant' && !isScaffold(e.text)) last = e.text
  }
  return last
}
