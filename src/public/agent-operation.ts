import { validateSettlementOption } from '../control/exec-settlement.js';
import { OperationScope } from '../control/operation-scope.js';
import { validateTimeoutMs } from '../process/run-process.js';
import type { Session } from '../session/session.js';
import type { AgentEvent, AgentInput, ProviderId, TurnOptions } from './types.js';

/** Opening and streaming share one budget while preserving native backpressure. */
export async function* streamAgentOperation(
  open: (scope: OperationScope) => Promise<Session>, provider: ProviderId,
  input: AgentInput, options: TurnOptions,
): AsyncIterable<AgentEvent> {
  validateSettlementOption(options.awaitSettlement);
  const scope = new OperationScope({ timeoutMs: validateTimeoutMs(options.timeoutMs), ...(options.signal ? { signal: options.signal } : {}), context: { provider, retryable: true } });
  try {
    const session = await scope.race(() => open(scope));
    yield* session.stream(input, { ...options, signal: scope.signal, timeoutMs: scope.remainingMs() });
  } finally {
    try {
      if (options.awaitSettlement) { await scope.drain(); scope.rethrowExecutionHalt(); }
    } finally { scope.dispose(); }
  }
}
