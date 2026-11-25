import { OperationScope } from '../../control/operation-scope.js';
import type { InteractionBroker } from '../../control/interaction-broker.js';
import type { ControlTurnRequest } from '../../session/control-session.js';

/** Thread-local cancellation; a shared App Server may keep sibling turns alive. */
export class CodexToolLifetime {
  readonly #controller = new AbortController();
  readonly #scope: OperationScope;
  readonly #onAbort: () => void;
  constructor(request: ControlTurnRequest, broker: InteractionBroker, sessionId: string) {
    this.#scope = new OperationScope({ timeoutMs: request.timeoutMs ?? 600_000,
      signal: request.signal ? AbortSignal.any([request.signal, this.#controller.signal]) : this.#controller.signal,
      context: { provider: 'codex', transport: 'control', retryable: true } });
    this.#onAbort = () => broker.expireScope(sessionId);
    this.signal.addEventListener('abort', this.#onAbort, { once: true });
    if (this.signal.aborted) this.#onAbort();
  }
  get signal(): AbortSignal { return this.#scope.signal; }
  get deadline(): number { return this.#scope.deadline; }
  cancel(): void {
    this.#controller.abort();
    this.signal.removeEventListener('abort', this.#onAbort);
    this.#scope.dispose();
  }
}
