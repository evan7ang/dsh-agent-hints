/** Read effective sibling configuration through the public Loader surface. */
import type { Context } from '@deepseek-ai/cordis';
import type { InheritedConnection } from './config.ts';
export declare const INHERIT_SOURCE_ID = "llm-deepseek";
/** Read live references on each call. Missing/disabled sources contribute nothing;
 * invalid sources surface an error rather than silently changing request targets.
 */
export declare function readInheritedConnection(ctx: Context, sourceId?: string): InheritedConnection;
