import { settleExecScope } from '../control/exec-settlement.js';
import { raceExecWork, resultUsage, streamStepUsage } from '../control/exec-usage.js';
import type { AdapterStreamItem, ExecAdapter, ExecProbeContext, ExecProbeTurn, ExecTurnRequest } from '../adapters/provider.js';
import { OperationScope } from '../control/operation-scope.js';
import { isAuthenticationConfirmed } from './auth-evidence.js';
import { NotAuthenticatedError, UnexpectedAuthSourceError } from '../public/errors.js';

/** A CLI login can change while a session remains open, independently of its binary. */
export class SubscriptionExecAdapter implements ExecAdapter {
  readonly id: ExecAdapter['id'];
  stream?: NonNullable<ExecAdapter['stream']>;

  constructor(readonly inner: ExecAdapter) {
    this.id = inner.id;
    const stream = inner.stream?.bind(inner);
    if (stream) {
      const check = this.#check.bind(this);
      this.stream = async function* (request) {
        const scope = new OperationScope({ timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}), context: { provider: inner.id, transport: 'exec', retryable: true } });
        let iterator: AsyncIterator<AdapterStreamItem> | undefined, exhausted = false;
        try {
          await scope.race(() => check(request, scope));
          iterator = stream({ ...request, requireSubscription: true, timeoutMs: scope.remainingMs(), signal: scope.signal })[Symbol.asyncIterator]();
          for (;;) {
            const step = await raceExecWork(scope, () => iterator!.next(), request.awaitSettlement, streamStepUsage);
            if (step.done) { exhausted = true; return; }
            yield step.value;
          }
        } finally { await settleExecScope(scope, request.awaitSettlement, iterator, exhausted); }
      };
    }
  }

  detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext) { return this.inner.detect(env, context); }
  auth(env: NodeJS.ProcessEnv, context?: ExecProbeContext, turn?: ExecProbeTurn) { return this.inner.auth(env, context, turn); }
  models() { return this.inner.models(); }
  async compatibility(env: NodeJS.ProcessEnv, version: string, context?: ExecProbeContext) {
    return this.inner.compatibility?.(env, version, context);
  }

  async execute(request: ExecTurnRequest) {
    const scope = new OperationScope({ timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}), context: { provider: this.id, transport: 'exec', retryable: true } });
    try {
      await scope.race(() => this.#check(request, scope));
      return await raceExecWork(scope, () => this.inner.execute({ ...request, requireSubscription: true, timeoutMs: scope.remainingMs(), signal: scope.signal }), request.awaitSettlement, resultUsage);
    } finally { if (request.awaitSettlement) await scope.drain(); scope.dispose(); }
  }

  async #check(request: ExecTurnRequest, scope: ExecProbeContext): Promise<void> {
    const context = { provider: this.id, transport: 'exec' as const, retryable: false };
    const auth = await this.inner.auth(request.env, scope, {
      cwd: request.cwd, contextArgs: request.contextArgs,
      ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
    });
    if (!isAuthenticationConfirmed(auth)) throw new NotAuthenticatedError(this.id, context);
    if (auth.source !== 'subscription') {
      throw new UnexpectedAuthSourceError(this.id, {
        ...context, sanitizedDiagnostics: { detectedSource: auth.source },
      });
    }
  }
}
