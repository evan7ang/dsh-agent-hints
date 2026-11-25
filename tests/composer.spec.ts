import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DraftObserver, type DraftObserverProps } from '../src/client/observer.ts'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import { composerDom } from './helpers/composer-dom.ts'

let tree: ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); tree = undefined })
function props(draft: string, notify: (id: string) => void, id = 'a'): DraftObserverProps {
  return { sessionId: SessionId(id), notify,
    useInput: ((select: (s: { draft: string }) => unknown) => select({ draft })) as DraftObserverProps['useInput'] }
}
function mount(draft: string, notify: (id: string) => void, id = 'a', dom = composerDom()) {
  dom.editor.textContent = draft
  act(() => { tree = create(createElement(DraftObserver, props(draft, notify, id)), { createNodeMock: () => dom.marker }) })
  return dom
}
describe('composer DOM edit notifications', () => {
  it('notifies once per nonempty editing cycle and rearms when cleared', () => {
    const notify = vi.fn(), dom = mount('', notify)
    for (const draft of [' ', 'hello', 'hello!', 'hello!!']) { dom.editor.textContent = draft; act(() => dom.fire()) }
    expect(notify).toHaveBeenCalledExactlyOnceWith('a')
    dom.editor.textContent = ''; act(() => dom.fire())
    dom.editor.textContent = 'next'; act(() => dom.fire())
    expect(notify).toHaveBeenCalledTimes(2)
  })
  it('keeps synchronous and asynchronous draft restoration silent', () => {
    const notify = vi.fn(); mount('saved', notify)
    act(() => tree!.update(createElement(DraftObserver, props('', notify, 'b'))))
    act(() => tree!.update(createElement(DraftObserver, props('restored later', notify, 'b'))))
    expect(notify).not.toHaveBeenCalled()
  })
  it('notifies on a same-length edit of a restored draft', () => {
    const notify = vi.fn(), dom = mount('saved', notify)
    dom.editor.textContent = 'paved'; act(() => dom.fire())
    expect(notify).toHaveBeenCalledExactlyOnceWith('a')
  })
  it('observes beforeinput and paste without waiting for a React snapshot', () => {
    const notify = vi.fn(), dom = mount('', notify)
    act(() => dom.fire('beforeinput', dom.editor, 'first'))
    act(() => dom.fire('paste', dom.editor, 'pasted'))
    expect(notify).toHaveBeenCalledExactlyOnceWith('a')
  })
  it('ignores whitespace and unrelated or disabled input elements', () => {
    const notify = vi.fn(), dom = mount('', notify)
    act(() => dom.fire('paste', dom.editor, '  '))
    act(() => dom.fire('beforeinput', {}, 'private unrelated input'))
    dom.editor.editable = false; act(() => dom.fire('beforeinput', dom.editor, 'disabled'))
    expect(notify).not.toHaveBeenCalled()
  })
  it('attributes edits to the newly selected session', () => {
    const notify = vi.fn(), dom = mount('', notify)
    act(() => tree!.update(createElement(DraftObserver, props('already pasted', notify, 'b'))))
    expect(notify).not.toHaveBeenCalled()
    dom.editor.textContent = 'already pasted!'; act(() => dom.fire())
    expect(notify).toHaveBeenCalledExactlyOnceWith('b')
  })
  it('removes listeners when the observer unmounts', () => {
    const notify = vi.fn(), dom = mount('', notify)
    act(() => tree!.unmount()); tree = undefined
    dom.editor.textContent = 'late'; dom.fire()
    expect(notify).not.toHaveBeenCalled()
  })
  it('falls back to request-time resume when no composer DOM is available', async () => {
    const send = vi.fn(async () => ({ status: 'accepted' as const, httpStatus: 200 }))
    const bridge = new LifecycleBridge({ client: { send } as never, pendingOpAwaitMs: 100 })
    try {
      bridge.noteOrdinaryRequest(SessionId('a'), 'm'); bridge.noteOrdinaryRequest(SessionId('b'), 'm')
      await bridge.awaitPendingOp(SessionId('a'))
      act(() => { tree = create(createElement(DraftObserver, props('pasted before mount', id => bridge.onSessionComposing(SessionId(id))))) })
      expect(send.mock.calls.map(args => args[0])).toEqual(['pause'])
      const release = await bridge.beginOrdinary(SessionId('a'), 'm'); release()
      expect(send.mock.calls.map(args => args[0])).toEqual(['pause', 'resume'])
    } finally { bridge.dispose() }
  })
})
