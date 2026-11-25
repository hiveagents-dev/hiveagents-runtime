import { classifyClaudeFailure } from '../failure-classification.js';
import { confirmedUsageRetryAt } from '../provider-limits.js';
import type { AgentEvent, Usage } from '../../public/types.js';
import { stringValue, type ProtocolFailure, type ProtocolResult } from '../provider.js';
import { diffTurnUsage, parseCumulativeUsage } from './usage.js';


/**
 * Projects the SDK's terminal `result` message onto a ProtocolResult. Usage is
 * cumulative per session in the SDK, so the previous cumulative figure is
 * needed to report this turn's share; the new cumulative figure is returned
 * for the caller to keep.
 */
export function finalizeResult(
  message: Record<string, unknown>,
  events: AgentEvent[],
  nativeEvents: unknown[],
  previousUsage: Usage | undefined,
  nativeSessionId: string | undefined,
): { result: ProtocolResult; cumulative: Usage | undefined } {
  const sessionId = stringValue(message.session_id) ?? nativeSessionId;
  const cumulative = parseCumulativeUsage(message);
  const usage = diffTurnUsage(previousUsage, cumulative);
  const subtype = stringValue(message.subtype);
  const failed = message.is_error === true || (subtype !== undefined && subtype.startsWith('error'));
  let failure = failed ? classifyClaudeFailure(message) : undefined;
  const retryAt = confirmedUsageRetryAt(events);
  if (failure && message.api_error_status === 429 && retryAt !== undefined)
    failure = { kind: 'usage-limit', message: 'Provider usage limit reached' };
  if (failure?.kind === 'usage-limit' && retryAt !== undefined) failure = { ...failure, retryAt };
  return {
    cumulative,
    result: {
      completed: failure === undefined,
      failed: failure !== undefined,
      refused: false,
      ...(sessionId === undefined ? {} : { sessionId }),
      text: stringValue(message.result) ?? '',
      ...(message.structured_output === undefined ? {} : { output: message.structured_output }),
      ...(usage === undefined ? {} : { usage }),
      events,
      ...(failure === undefined ? {} : { failure }),
      terminalEvent: message,
      nativeEvents,
    },
  };
}
