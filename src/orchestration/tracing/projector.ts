import type { AgentEvent } from '../../public/types.js';
import type { TraceEventInput } from './types.js';
import { validateEvent } from './validation.js';

/** Construct a fresh whitelist; never copy or serialize a complete provider object. */
export function projectAgentEvent(event: AgentEvent): TraceEventInput {
  let projected: TraceEventInput;
  switch (event.type) {
    case 'session.started': projected = { type: event.type, sessionId: event.session.id }; break;
    case 'turn.started': projected = { type: event.type, ...(event.turnId === undefined ? {} : { turnId: event.turnId }) }; break;
    case 'message.delta':
    case 'message.completed': projected = { type: event.type, count: event.text.length }; break;
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed': projected = { type: event.type, toolId: event.id }; break;
    case 'subagent.started':
    case 'subagent.completed': projected = { type: event.type, subagentId: event.id }; break;
    case 'interaction.requested': projected = { type: event.type, interactionId: event.request.binding.interactionId,
      sessionId: event.request.binding.sessionId,
      ...(event.request.binding.turnId === undefined ? {} : { turnId: event.request.binding.turnId }) }; break;
    case 'context.compacted':
    case 'provider.event': projected = { type: event.type }; break;
    case 'turn.completed':
      if (!['completed', 'failed', 'interrupted', 'refused'].includes(event.turn.status)) throw new Error('Invalid trace turn status');
      projected = { type: event.type, sessionId: event.turn.session.id,
      ...(event.turn.id === undefined ? {} : { turnId: event.turn.id }), status: event.turn.status,
      ...(event.turn.usage === undefined ? {} : { usage: event.turn.usage }) }; break;
    default: throw new Error('Unsupported trace agent event');
  }
  return validateEvent(projected);
}
