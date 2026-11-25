/** Observe composer edits locally; draft text never leaves the browser. */
import { createElement, useLayoutEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

export type DraftObserverProps = Pick<PropsRuntime<'conversation.input.overlay'>, 'sessionId' | 'useInput'> & {
  notify: (sessionId: string) => void
}

/**
 * Stock rc.2 composer markers scope DOM edit events to this overlay's editor.
 * Snapshot restoration is silent. Edits preceding mount use request-time
 * resume. Missing markers fall back instead of observing unrelated inputs.
 */
export function DraftObserver({ sessionId, useInput, notify }: DraftObserverProps) {
  const length = useInput((input: InputState) => input.draft.trim().length)
  const marker = useRef<HTMLSpanElement>(null)
  const state = useRef({ sessionId, announced: false })
  useLayoutEffect(() => {
    if (state.current.sessionId !== sessionId || length === 0) state.current = { sessionId, announced: false }
  }, [sessionId, length])
  useLayoutEffect(() => {
    const owner = marker.current?.closest('[data-slot="conversation.composer.bar"]')
    if (!owner) return
    const editorOf = (event: Event): Element | undefined => {
      const target = event.target as Element | null
      const editor = typeof target?.closest === 'function' ? target.closest('[data-composer-input="true"]') : null
      return editor && owner.contains(editor) && editor.getAttribute('contenteditable') === 'true' ? editor : undefined
    }
    const announce = (): void => {
      if (state.current.sessionId !== sessionId || state.current.announced) return
      state.current.announced = true
      notify(sessionId)
    }
    const input = (event: Event): void => {
      const editor = editorOf(event)
      if (!editor) return
      if (editor.textContent?.trim()) announce()
      else state.current.announced = false
    }
    const insertion = (event: Event): void => {
      const edit = event as InputEvent
      if (editorOf(event) && edit.inputType?.startsWith('insert') && edit.data?.trim()) announce()
    }
    const paste = (event: Event): void => {
      if (editorOf(event) && (event as ClipboardEvent).clipboardData?.getData('text/plain').trim()) announce()
    }
    const capture = { capture: true }
    owner.addEventListener('beforeinput', insertion, capture)
    owner.addEventListener('paste', paste, capture)
    owner.addEventListener('input', input, capture)
    return () => {
      owner.removeEventListener('beforeinput', insertion, capture)
      owner.removeEventListener('paste', paste, capture)
      owner.removeEventListener('input', input, capture)
    }
  }, [sessionId, notify])
  return createElement('span', { ref: marker, hidden: true, 'data-agent-hint-observer': '' })
}
