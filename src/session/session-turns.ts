import type { ExecOperation, ProtocolResult } from '../adapters/provider.js';
import type { AgentEvent, AgentInput, PinnedTurnNote, SessionIdentity, Turn, TurnOptions } from '../public/types.js';
import type { SessionConfig } from './config.js';
import { ControlTurnLifecycle } from './control-lifecycle.js';
import { checkExecRequest, inputToPrompt } from './exec-turn.js';
import { annotateMemory, type RecalledTurn } from './memory.js';
import type { MemoryCall } from './memory-turn.js';
import { annotateTurn, checkControl } from './pinned.js';
import { cancelledBeforeRun } from './session-guards.js';
import { structuredOutputValidator } from './validation.js';

/**
 * The synchronous refusals a turn without memory makes before it runs, in its order, then
 * `acquire`. Exec: structured output, the input, the pinned option, the deadline, then the
 * session. Control: structured output, the pinned option, the session, then the control turn's
 * own options (a refusal there gives the session back, as the turn without memory does). The
 * pinned option is only checked here: the turn delivers it once recall is done.
 */
export function preflightTurn(
  config: SessionConfig, input: AgentInput, options: TurnOptions, mode: ExecOperation, acquire: () => void, release: () => void,
): void {
  structuredOutputValidator(config, options);
  if (config.control) {
    checkControl(config);
    acquire();
    try { new ControlTurnLifecycle(config.adapter.id, options).dispose(); } catch (error) { release(); throw error; }
    return;
  }
  inputToPrompt(input, config.adapter.id);
  checkExecRequest(config, options, mode);
  acquire();
}

/** What the memory wrappers need from a session with memory; undefined without it. */
export function memoryCall(config: SessionConfig, steering: boolean): MemoryCall | undefined {
  const memory = config.memory;
  return memory && {
    memory, steering,
    context: { provider: config.adapter.id, transport: config.transport, cwd: config.cwd },
    cancelled: (reason) => cancelledBeforeRun(config, reason),
  };
}

/** The Turn a completed result becomes, with what the pinned option and memory did recorded on it. */
export function completedTurn(
  config: SessionConfig, ref: SessionIdentity, result: ProtocolResult, events: AgentEvent[],
  note: PinnedTurnNote | undefined, recalled: RecalledTurn | undefined,
): Turn {
  return annotateMemory(annotateTurn({
    ...(result.turnId === undefined ? {} : { id: result.turnId }),
    session: ref,
    status: result.refused ? 'refused' : 'completed',
    text: result.text,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    events,
    warnings: [...config.warnings],
    providerMetadata: {
      nativeEventCount: result.nativeEvents.length,
      terminalEventPresent: result.terminalEvent !== undefined,
    },
  }, note), recalled?.note);
}
