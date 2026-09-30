import { describe, expect, it, vi } from 'vitest'
import { appendToDraft, apply, inject } from '../src/client/index.tsx'

function fixture(initialDraft = '') {
  const setDraft = vi.fn()
  const focus = vi.fn()
  const input = {
    state: { getSnapshot: () => ({ draft: initialDraft }) },
    setDraft,
    focus,
  }
  const conversation = { input: { for: vi.fn(() => input) } }
  const scopedGet = vi.fn((key: string) => key === 'conversation' ? conversation : undefined)
  const scope = {
    get<T = unknown>(key: string): T | undefined {
      return scopedGet(key) as T | undefined
    },
  }
  const root = { sessions: { scope: vi.fn(() => scope) } }
  return { root, scope, scopedGet, conversation, setDraft, focus }
}

describe('DSH 2.0 composer injection', () => {
  it('resolves conversation through the session scope', () => {
    const f = fixture()

    expect(appendToDraft(f.root, 'session-1', '继续任务')).toBe(true)
    expect(f.root.sessions.scope).toHaveBeenCalledWith('session-1')
    expect(f.scopedGet).toHaveBeenCalledWith('conversation')
    expect(f.conversation.input.for).toHaveBeenCalledWith(f.scope)
    expect(f.setDraft).toHaveBeenCalledWith('继续任务')
    expect(f.focus).toHaveBeenCalledOnce()
  })

  it('appends to an existing draft and fails safely without a scoped service', () => {
    const f = fixture('已有内容')
    expect(appendToDraft(f.root, 'session-1', '继续任务')).toBe(true)
    expect(f.setDraft).toHaveBeenCalledWith('已有内容 继续任务')

    const missing = { sessions: { scope: () => ({ get: () => undefined }) } }
    expect(appendToDraft(missing as any, 'session-2', '继续任务')).toBe(false)
  })

  it('passes a scoped draft writer to the sidebar slot component', () => {
    const f = fixture()
    let slotOptions: any
    const ctx = {
      ...f.root,
      effect: (fn: () => void) => fn(),
      sidebarRightTabs: { register: vi.fn(() => vi.fn()) },
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: vi.fn((options: any) => { slotOptions = options; return vi.fn() }),
      },
    }

    expect(inject).toContain('sessions')
    apply(ctx as any)
    const props = slotOptions.inject('session-1')
    expect(props.sessionId).toBe('session-1')
    expect(props.appendDraft('继续任务')).toBe(true)
    expect(f.setDraft).toHaveBeenCalledWith('继续任务')
  })
})
