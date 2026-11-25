import type { ValidateFunction } from 'ajv';

import type { ProtocolResult } from '../adapters/provider.js';
import { ProtocolError } from '../public/errors.js';
import type { AgentEvent, InterruptReceipt, Turn, TurnHandle } from '../public/types.js';

/**
 * The two things a transport-specific turn runner needs back from `Session`:
 * adopting the provider's native session id, and turning a terminal result
 * into a public `Turn`. Both transports project through the same pair.
 */
export interface TurnProjection {
  /** Returns the session.started event on first adoption; throws on an id change. */
  adopt(sessionId: string): AgentEvent | undefined;
  complete(result: ProtocolResult, events: AgentEvent[], validate?: ValidateFunction): Turn;
}

/**
 * Wraps an already-finished `Turn` in the `TurnHandle` shape. `forkAndStart`
 * needs it because the fork RPC only confirms the child once its first turn
 * has run: the handle is handed back settled, never mid-flight. Steering is
 * absent by construction — nothing can be steered into a finished turn.
 */
export function settledTurnHandle(turn: Turn): TurnHandle {
  const terminal: InterruptReceipt['terminal'] = turn.status === 'interrupted'
    ? 'interrupted'
    : turn.status === 'failed'
      ? 'failed'
      : 'completed';
  return {
    token: { value: turn.id ?? `settled:${turn.session.id}` },
    turnId: Promise.resolve(turn.id),
    events: (async function* replay() { yield* turn.events; })(),
    result: Promise.resolve(turn),
    interrupt: async () => ({ requested: false, terminal }),
    detach: () => undefined,
    respond: async () => {
      throw new ProtocolError(
        { provider: turn.session.provider, retryable: false },
        'This turn already settled; no interaction is pending',
      );
    },
  };
}
