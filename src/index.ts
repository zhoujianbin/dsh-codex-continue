import { resolveConfig } from './config.ts'
import { createCodexTool } from './tool.ts'
import { registerCodexRoutes } from './routes.ts'
import { CodexContinueService } from './service.ts'
import type { CodexContinueConfig } from './types.ts'

/**
 * dsh-codex-continue host half.
 *
 * Reads local OpenAI Codex projects & sessions (~/.codex, read-only),
 * exposes them as a `codex` tool and a /codex-continue/api REST API, and
 * builds resume bundles so a DSH agent can continue a Codex session after
 * the 5h usage limit.
 */
export const name = 'dsh-codex-continue'

export const inject = ['webServer', 'tools']

export function apply(ctx: {
  config: Partial<CodexContinueConfig>
  webServer: { register(r: unknown): unknown }
  tools: { register(t: unknown): unknown }
  provide(name: string, value: unknown): unknown
}): void {
  const config = resolveConfig(ctx.config)
  const service = new CodexContinueService(config)

  ctx.provide('codexContinue', service)

  registerCodexRoutes(ctx, service)

  ctx.tools.register(createCodexTool(service))
}

export { CodexContinueService } from './service.ts'
export type { SessionDetail } from './service.ts'
export type { CodexContinueConfig, ResumeBundle, CodexSessionIndex, CodexProject, CodexEvent } from './types.ts'
export { resolveConfig } from './config.ts'
export { parseRollout, parseRolloutText, isScaffold, normalizeText } from './codex-parser.ts'
export { compactTranscript, estimateTokens, buildResumeBundle } from './resume-builder.ts'
