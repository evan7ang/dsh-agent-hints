var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
/** A live service discovered through the stock Gateway's Remote markers. */
let AgentHintSignals = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _available_decorators;
    let _activated_decorators;
    let _composing_decorators;
    return class AgentHintSignals extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _available_decorators = [Remote];
            _activated_decorators = [Remote];
            _composing_decorators = [Remote];
            __esDecorate(this, null, _available_decorators, { kind: "method", name: "available", static: false, private: false, access: { has: obj => "available" in obj, get: obj => obj.available }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _activated_decorators, { kind: "method", name: "activated", static: false, private: false, access: { has: obj => "activated" in obj, get: obj => obj.activated }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _composing_decorators, { kind: "method", name: "composing", static: false, private: false, access: { has: obj => "composing" in obj, get: obj => obj.composing }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        bridge = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, bridge) {
            super(ctx, 'agentHintSignals');
            this.bridge = bridge;
        }
        /** Read-only capability probe; this service exists only while plugin controls are enabled. */
        available() {
            return true;
        }
        /**
         * The visible composer was mounted or switched to this session. Advisory only;
         * the existing bridge ignores unknown/archived sessions and deduplicates resume.
         * No draft text or Agent execution is admitted through this endpoint.
         */
        activated(request) {
            this.composing(request);
        }
        /**
         * Note a composer transition; does not create/resume an Agent or accept draft text.
         * The bridge acts only on sessions already known to this provider route.
         * @param request - wire object containing only a nonempty sessionId (at most 512 characters).
         */
        composing(request) {
            if (typeof request !== 'object' || request === null || Array.isArray(request)
                || Object.keys(request).length !== 1 || !('sessionId' in request)
                || typeof request.sessionId !== 'string' || request.sessionId.length === 0
                || request.sessionId.length > 512)
                return;
            this.bridge.onSessionComposing(SessionId(request.sessionId));
        }
    };
})();
export { AgentHintSignals };
