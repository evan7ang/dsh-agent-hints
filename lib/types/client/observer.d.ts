import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
export type DraftObserverProps = Pick<PropsRuntime<'conversation.input.overlay'>, 'sessionId' | 'useInput'> & {
    notify: (sessionId: string) => void;
};
/**
 * Stock rc.2 composer markers scope DOM edit events to this overlay's editor.
 * Snapshot restoration is silent. Edits preceding mount use request-time
 * resume. Missing markers fall back instead of observing unrelated inputs.
 */
export declare function DraftObserver({ sessionId, useInput, notify }: DraftObserverProps): import("react").DetailedReactHTMLElement<{
    ref: import("react").RefObject<HTMLSpanElement>;
    hidden: true;
    'data-agent-hint-observer': string;
}, HTMLSpanElement>;
