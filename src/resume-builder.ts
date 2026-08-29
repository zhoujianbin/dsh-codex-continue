import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import {
  goalOf,
  isScaffold,
  lastAssistantMessageOf,
  lastUserMessageOf,
} from './codex-parser.ts'
import type { CodexEvent, CodexSessionIndex, ResumeBundle } from './types.ts'

/**
 * Builds the resume bundle: a compact, decision-dense handoff of one Codex
 * session that a DSH agent can act on. Tool outputs are truncated and paired
 * with their calls; the transcript keeps the goal plus the most recent
 * events within a token budget (budget cap is configurable).
 */

export interface ResumeOptions {
  maxBundleTokens: number
  toolOutputTail: number
  argsPreview: number
  messageMax: number
  includeGitStatus: boolean
}

/** Rough token estimate: 1 token ≈ 1.6 chars (mixed CJK/ASCII). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.6)
}

interface Line {
  text: string
  tokens: number
}

const REASONING_MAX = 300

function toolLine(e: Extract<CodexEvent, { kind: 'tool' }>, argsPreview: number): string {
  const args = e.argsPreview.replace(/\s+/g, ' ').trim().slice(0, argsPreview)
  return args ? `  ▶ ${e.name}: ${args}` : `  ▶ ${e.name}`
}

function resultLine(e: Extract<CodexEvent, { kind: 'toolResult' }>, toolOutputTail: number): string {
  const tail = e.tail.replace(/\s+/g, ' ').trim().slice(-toolOutputTail)
  const exit = e.exit === null ? '' : ` exit=${e.exit}`
  return `    └${exit} tail=${tail}`.slice(0, 500)
}

/** Build the compact transcript with call/result pairing, capped by budget. */
export function compactTranscript(
  events: CodexEvent[],
  opts: Pick<ResumeOptions, 'toolOutputTail' | 'argsPreview' | 'messageMax'>,
  maxTokens: number,
): { lines: string[]; tokens: number; truncated: boolean } {
  const lines: Line[] = []
  let pendingCallId: string | undefined
  let pendingToolIndex = -1

  const push = (text: string): void => {
    const tokens = estimateTokens(text)
    lines.push({ text, tokens })
  }

  for (const e of events) {
    if (e.kind === 'turnStart') {
      // turn boundaries add noise; skip
    } else if (e.kind === 'reasoning') {
      const s = e.summary.replace(/\s+/g, ' ').trim().slice(0, REASONING_MAX)
      if (s) push(`  (思考: ${s})`)
    } else if (e.kind === 'user' || e.kind === 'assistant') {
      if (isScaffold(e.text)) continue
      const role = e.kind === 'user' ? 'user' : 'agent'
      const text = e.text.replace(/\s+/g, ' ').trim().slice(0, opts.messageMax)
      push(`${role}: ${text}`)
    } else if (e.kind === 'tool') {
      pendingCallId = e.callId
      pendingToolIndex = lines.length
      push(toolLine(e, opts.argsPreview))
    } else if (e.kind === 'toolResult') {
      const paired = pendingCallId !== undefined && (e.callId === pendingCallId || e.callId === undefined)
      if (paired && pendingToolIndex >= 0) {
        pendingCallId = undefined
        pendingToolIndex = -1
        push(resultLine(e, opts.toolOutputTail))
      } else {
        // orphan result (call outside the kept window) — keep as evidence
        push(resultLine(e, opts.toolOutputTail))
      }
    }
  }

  // Greedy tail-window within budget, then prepend the goal if it fits.
  const goalIndex = lines.findIndex((l) => l.text.startsWith('user:'))
  let total = 0
  const kept: Line[] = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!
    if (total + l.tokens > maxTokens) break
    total += l.tokens
    kept.unshift(l)
  }
  const truncated = kept.length < lines.length
  if (goalIndex >= 0 && goalIndex !== 0 && kept[0] !== lines[goalIndex]) {
    const goal = lines[goalIndex]!
    if (total + goal.tokens <= maxTokens) {
      kept.unshift(goal)
      total += goal.tokens
    } else if (goal.tokens <= maxTokens) {
      // goal replaces the head of the kept window
      kept[0] = goal
      total = goal.tokens + (kept.length > 1 ? kept.slice(1).reduce((a, l) => a + l.tokens, 0) : 0)
      if (total > maxTokens) {
        // drop from the tail until it fits
        while (kept.length > 1 && total > maxTokens) {
          const dropped = kept.pop()!
          total -= dropped.tokens
        }
      }
    }
  }

  return { lines: kept.map((l) => l.text), tokens: total, truncated }
}

/** Last few exec commands + exit codes, as quick state hints. */
export function stateHintsOf(events: CodexEvent[]): { lastCommands: string[]; lastExitCodes: number[] } {
  const lastCommands: string[] = []
  const lastExitCodes: number[] = []
  for (const e of events) {
    if (e.kind === 'tool' && e.name === 'exec_command') {
      lastCommands.push(e.argsPreview.replace(/\s+/g, ' ').trim().slice(0, 200))
      if (lastCommands.length > 5) lastCommands.shift()
    } else if (e.kind === 'toolResult' && e.exit !== null && e.exit !== undefined) {
      lastExitCodes.push(e.exit)
      if (lastExitCodes.length > 5) lastExitCodes.shift()
    }
  }
  return { lastCommands, lastExitCodes }
}

async function gitSummary(cwd: string): Promise<{ dirty: boolean; summary: string } | null> {
  try {
    const { stdout } = await runGit(cwd, ['status', '--porcelain'])
    const dirty = stdout.trim().length > 0
    const lines = stdout.trim().split('\n').filter(Boolean).slice(0, 12)
    let summary = dirty ? `${lines.length} 个未提交变更\n` + lines.join('\n').slice(0, 600) : 'clean'
    return { dirty, summary }
  } catch {
    return null // not a git repo or git missing
  }
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout: stdout.toString() })
    })
    child.on('error', reject)
  })
}

/**
 * Build the resume bundle for one session. cwd existence and git status are
 * best-effort (both degrade silently).
 */
export async function buildResumeBundle(
  entry: CodexSessionIndex,
  events: CodexEvent[],
  opts: ResumeOptions,
): Promise<ResumeBundle> {
  const goal = goalOf(events)
  const lastUserMessage = lastUserMessageOf(events)
  const lastAssistantMessage = lastAssistantMessageOf(events)
  const compact = compactTranscript(events, opts, opts.maxBundleTokens)
  const hints = stateHintsOf(events)
  let cwdExists = true
  try {
    await fsp.access(entry.cwd)
  } catch {
    cwdExists = false
  }

  const git = opts.includeGitStatus && cwdExists ? await gitSummary(entry.cwd) : null

  return {
    sessionId: entry.sessionId,
    title: (entry.title ?? goal.slice(0, 40)) || entry.sessionId,
    cwd: entry.cwd,
    cwdExists,
    model: entry.modelProvider,
    cliVersion: entry.cliVersion,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    goal: goal.slice(0, 1200),
    lastUserMessage: lastUserMessage.slice(0, 2000),
    lastAssistantMessage: lastAssistantMessage.slice(0, 2000),
    transcript: compact.lines,
    stateHints: hints,
    git,
    stats: {
      totalEvents: events.length,
      compactEvents: compact.lines.length,
      estimatedTokens: compact.tokens,
      truncated: compact.truncated,
    },
  }
}
