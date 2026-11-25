/** Plugin-owned Remote endpoint for advisory composer activity on stock DSH. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LifecycleBridge } from './lifecycle-bridge.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Composer notifications owned by this provider plugin. */
    agentHintSignals: AgentHintSignals
  }
}

/** A live service discovered through the stock Gateway's Remote markers. */
export class AgentHintSignals extends TypertRemoteService {
  constructor(ctx: Context, private readonly bridge: LifecycleBridge) {
    super(ctx, 'agentHintSignals')
  }

  /** Read-only capability probe; this service exists only while plugin controls are enabled. */
  @Remote
  available(): boolean {
    return true
  }

  /**
   * The visible composer was mounted or switched to this session. Advisory only;
   * the existing bridge ignores unknown/archived sessions and deduplicates resume.
   * No draft text or Agent execution is admitted through this endpoint.
   */
  @Remote
  activated(request: unknown): void {
    this.composing(request)
  }

  /**
   * Note a composer transition; does not create/resume an Agent or accept draft text.
   * The bridge acts only on sessions already known to this provider route.
   * @param request - wire object containing only a nonempty sessionId (at most 512 characters).
   */
  @Remote
  composing(request: unknown): void {
    if (typeof request !== 'object' || request === null || Array.isArray(request)
      || Object.keys(request).length !== 1 || !('sessionId' in request)
      || typeof request.sessionId !== 'string' || request.sessionId.length === 0
      || request.sessionId.length > 512) return
    this.bridge.onSessionComposing(SessionId(request.sessionId))
  }
}
