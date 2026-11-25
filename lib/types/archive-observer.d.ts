import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** The public registry methods required by the archive observer. */
export type ArchiveRegistry = Pick<WorkspaceRegistry, 'archiveSession' | 'unarchiveSession' | 'archivedSessionIds'>;
/**
 * Wrap public registry calls, retaining their receiver, result and failures.
 * Only committed archive transitions notify; failed or redundant writes do not.
 * @param registry - live workspace registry, possibly a Cordis service view.
 * @param archived - advisory callback after an archive succeeds.
 * @param unarchived - callback allowing a later archive cycle to notify again.
 * @returns disposer restoring only this observer's wrappers; later wrappers are preserved.
 */
export declare function observeArchives(registry: ArchiveRegistry, archived: (id: SessionId) => void, unarchived: (id: SessionId) => void): () => void;
