import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { observeArchives } from '../src/archive-observer.ts'

const SID = SessionId('session-a')
function registry() {
  return {
    archivedSessionIds: [] as SessionId[],
    async archiveSession(id: SessionId) {
      if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id)
    },
    async unarchiveSession(id: SessionId) {
      this.archivedSessionIds = this.archivedSessionIds.filter(x => x !== id)
    },
  }
}
describe('public archive observer', () => {
  it('observes an immediate archive/unarchive pair in committed order', async () => {
    const host = registry(), events: string[] = []
    const off = observeArchives(host, () => events.push('archive'), () => events.push('unarchive'))
    await Promise.all([host.archiveSession(SID), host.unarchiveSession(SID)])
    expect(events).toEqual(['archive', 'unarchive'])
    expect(host.archivedSessionIds).toEqual([])
    off()
  })
  it('observes committed transitions and restores exact original methods', async () => {
    const host = registry(), archived = vi.fn(), unarchived = vi.fn()
    const original = host.archiveSession
    const off = observeArchives(host, archived, unarchived)
    await host.archiveSession(SID)
    expect(archived).toHaveBeenCalledExactlyOnceWith(SID)
    await host.archiveSession(SID)
    expect(archived).toHaveBeenCalledTimes(1)
    await host.unarchiveSession(SID)
    expect(unarchived).toHaveBeenCalledExactlyOnceWith(SID)
    await host.archiveSession(SID)
    expect(archived).toHaveBeenCalledTimes(2)
    off()
    expect(host.archiveSession).toBe(original)
    expect(Object.hasOwn(host, 'archiveSession')).toBe(true)
  })
  it('keeps failed archive operations failed and sends no notification', async () => {
    const host = registry(), archived = vi.fn()
    host.archiveSession = async () => { throw new Error('storage unavailable') }
    const off = observeArchives(host, archived, vi.fn())
    await expect(host.archiveSession(SID)).rejects.toThrow('storage unavailable')
    expect(archived).not.toHaveBeenCalled()
    off()
  })
  it('does not overwrite a later wrapper and deactivates its retained callback', async () => {
    const host = registry(), archived = vi.fn()
    const off = observeArchives(host, archived, vi.fn())
    const installed = host.archiveSession
    const later = async (id: SessionId) => installed.call(host, id)
    host.archiveSession = later
    off()
    expect(host.archiveSession).toBe(later)
    await host.archiveSession(SID)
    expect(archived).not.toHaveBeenCalled()
  })
  it('restores inherited methods without leaving own shadows', async () => {
    const proto = registry()
    const host = Object.create(proto) as ReturnType<typeof registry>
    const off = observeArchives(host, vi.fn(), vi.fn())
    expect(Object.hasOwn(host, 'archiveSession')).toBe(true)
    off()
    expect(Object.hasOwn(host, 'archiveSession')).toBe(false)
    expect(host.archiveSession).toBe(proto.archiveSession)
  })
})
