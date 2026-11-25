/** Observe successful public archive operations without changing the host implementation on disk. */
import { symbols } from '@deepseek-ai/cordis'
import type { ArchiveSessionOptions, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The public registry methods required by the archive observer. */
export type ArchiveRegistry = Pick<WorkspaceRegistry, 'archiveSession' | 'unarchiveSession' | 'archivedSessionIds'>

/**
 * Wrap public registry calls, retaining their receiver, result and failures.
 * Only committed archive transitions notify; failed or redundant writes do not.
 * @param registry - live workspace registry, possibly a Cordis service view.
 * @param archived - advisory callback after an archive succeeds.
 * @param unarchived - callback allowing a later archive cycle to notify again.
 * @returns disposer restoring only this observer's wrappers; later wrappers are preserved.
 */
export function observeArchives(
  registry: ArchiveRegistry,
  archived: (id: SessionId) => void,
  unarchived: (id: SessionId) => void,
): () => void {
  const raw: unknown = Reflect.get(registry, symbols.original)
  const target = typeof raw === 'object' && raw !== null ? raw : registry
  let active = true
  // Include observation in the same queue as each wrapped operation. Reading
  // "before" outside it misses an unarchive called while archive is pending.
  let pending: Promise<unknown> = Promise.resolve()
  const restores: (() => void)[] = []
  const install = (key: 'archiveSession' | 'unarchiveSession'): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    const previous = registry[key]
    const wrapper = async function (this: ArchiveRegistry, id: SessionId, ...args: [options?: ArchiveSessionOptions]) {
      const operation = pending.then(async () => {
        const before = this.archivedSessionIds.includes(id)
        await Reflect.apply(previous, this, [id, ...args])
        if (!active) return
        const after = this.archivedSessionIds.includes(id)
        if (key === 'archiveSession' && !before && after) archived(id)
        if (key === 'unarchiveSession' && before && !after) unarchived(id)
      })
      pending = operation.catch(() => undefined)
      await operation
    }
    Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapper })
    restores.push(() => {
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) return
      if (descriptor === undefined) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, descriptor)
    })
  }
  try {
    install('archiveSession')
    install('unarchiveSession')
  } catch (error) {
    active = false
    for (const restore of restores.reverse()) restore()
    throw error
  }
  return () => {
    active = false
    for (const restore of restores.reverse()) restore()
  }
}
