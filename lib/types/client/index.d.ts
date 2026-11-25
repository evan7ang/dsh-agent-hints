/** Browser face: contribute an invisible observer through the stock composer slot. */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "agent-hint-composer";
export declare const inject: string[];
/**
 * Install advisory notifications through the existing authenticated Connection.
 * Missing services and failed notifications leave composing/submission unaffected.
 * @param ctx - browser plugin context owning the slot contribution and RPC lifetime.
 */
export declare function apply(ctx: Context): void;
