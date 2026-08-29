import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

describe('plugin entry', () => {
  it('reads loader configuration from the second apply argument', () => {
    const registerRoute = vi.fn()
    const registerTool = vi.fn()
    const provide = vi.fn()
    const context = new Proxy({
      webServer: { register: registerRoute },
      tools: { register: registerTool },
      provide,
    }, {
      get(target, property, receiver) {
        if (property === 'config') throw new Error('ctx.config must not be read')
        return Reflect.get(target, property, receiver)
      },
    })

    apply(context, {
      codexHome: '/tmp/codex-home',
      cacheDir: '/tmp/codex-cache',
      maxAgeDays: 7,
    })

    expect(provide).toHaveBeenCalledWith('codexContinue', expect.anything())
    expect(registerRoute).toHaveBeenCalledOnce()
    expect(registerTool).toHaveBeenCalledOnce()
  })
})
