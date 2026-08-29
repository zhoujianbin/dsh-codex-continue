/**
 * Shared types for dsh-codex-continue: the normalized view of a Codex
 * rollout session and the resume bundle handed to the DSH agent.
 */

/** One normalized conversation event (parsed from a rollout JSONL line). */
export type CodexEvent =
  | { kind: 'turnStart'; turnId?: string; at?: number }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; summary: string }
  | { kind: 'tool'; name: string; argsPreview: string; callId?: string }
  | { kind: 'toolResult'; callId?: string; exit?: number | null; tail: string; truncated: boolean }

/** Index entry for one Codex session. */
export interface CodexSessionIndex {
  /** session_id from session_meta == id in ~/.codex/session_index.jsonl. */
  sessionId: string
  /** thread_name from the index; undefined when the index has no row. */
  title?: string
  /** Project working directory (session_meta.cwd). */
  cwd: string
  cliVersion?: string
  modelProvider?: string
  startedAt?: string
  updatedAt?: string
  rolloutPath: string
  archived: boolean
  messageCount: number
  /** True when the file was skipped (missing session_meta / corrupt). */
  broken?: boolean
}

/** A project = one working directory, aggregating its sessions. */
export interface CodexProject {
  cwd: string
  name: string
  sessionCount: number
  lastUpdatedAt?: string
}

/** The compact, decision-dense context handed to the DSH agent. */
export interface ResumeBundle {
  sessionId: string
  title: string
  cwd: string
  cwdExists: boolean
  model?: string
  cliVersion?: string
  startedAt?: string
  updatedAt?: string
  goal: string
  lastUserMessage: string
  lastAssistantMessage: string
  transcript: string[]
  stateHints: {
    lastCommands: string[]
    lastExitCodes: number[]
  }
  git?: {
    dirty: boolean
    summary: string
  } | null
  stats: {
    totalEvents: number
    compactEvents: number
    estimatedTokens: number
    truncated: boolean
  }
}

/** Plugin configuration (cordis.patch.yml `config` block). */
export interface CodexContinueConfig {
  /** Root of the Codex data directory. */
  codexHome: string
  /** Approximate token budget for a resume bundle transcript. */
  maxBundleTokens: number
  /** Tail of a tool output kept in the transcript. */
  toolOutputTail: number
  /** Preview length of tool arguments. */
  argsPreview: number
  /** Cap on a single user/assistant message in the transcript. */
  messageMax: number
  /** Where the session index cache lives. */
  cacheDir: string
  /** Run `git status` in the project dir when building a bundle. */
  includeGitStatus: boolean
  /** Max age of a session to list (0 = all). */
  maxAgeDays: number
}

export const DEFAULT_CONFIG: CodexContinueConfig = {
  codexHome: '~/.codex',
  maxBundleTokens: 60_000,
  toolOutputTail: 400,
  argsPreview: 200,
  messageMax: 2_000,
  cacheDir: '~/.dsh/plugin-data/codex-continue',
  includeGitStatus: true,
  maxAgeDays: 0,
}
