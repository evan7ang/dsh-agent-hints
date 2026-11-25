/** Minimal scoped DOM event boundary for React renderer tests. */
export function composerDom() {
  const owner = new EventTarget(), editor = { textContent: '', editable: true,
    closest: () => editor, getAttribute: () => editor.editable ? 'true' : 'false' }
  Object.assign(owner, { contains: (node: unknown) => node === editor })
  const marker = { closest: (selector: string) => selector === '[data-slot="conversation.composer.bar"]' ? owner : null }
  return { marker, editor,
    fire: (type = 'input', target: unknown = editor, data?: string) => {
      const event = new Event(type)
      Object.defineProperties(event, { target: { value: target }, data: { value: data }, inputType: { value: 'insertText' },
        clipboardData: { value: { getData: () => data ?? '' } } })
      owner.dispatchEvent(event)
    } }
}
