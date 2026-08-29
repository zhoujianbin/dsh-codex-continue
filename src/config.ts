import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, type CodexContinueConfig } from './types.ts'

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * Merge a partial raw config (from the cordis.patch.yml `config` block)
 * over the defaults and normalize paths. The Loader may pass undefined when
 * the row has no config, so callers must always go through here.
 */
export function resolveConfig(raw: Partial<CodexContinueConfig> | undefined): CodexContinueConfig {
  const merged: CodexContinueConfig = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  merged.codexHome = expandHome(merged.codexHome)
  merged.cacheDir = expandHome(merged.cacheDir)
  return merged
}
