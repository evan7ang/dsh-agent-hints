/**
 * Declaration merging for the two host events this plugin listens to.
 *
 * `session/composing` and `workspace/session-archived` are emitted by a DSH
 * host that carries the AgentHint control-plane patch set. Declaring them here
 * keeps this package compilable and installable against a stock host: the
 * listeners register normally. On a stock host, the plugin-owned composer
 * Remote and the public archive observer supply the missing triggers without
 * these core events.
 *
 * @module @deepseek-ai/dsh-llm-agent-hint/host-events
 */
import type { SessionId } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * A client reported that a session's composer draft became non-empty.
         * Advisory only: the host never resumes or publishes an Agent from it.
         * @param sessionId - session whose composer became active.
         */
        'session/composing'(sessionId: SessionId): void;
        /**
         * A session became hidden from every workspace grouping surface. Emitted
         * after the archive set is durable, once per session and archive.
         * @param sessionId - the session just archived.
         */
        'workspace/session-archived'(sessionId: SessionId): void;
    }
}
