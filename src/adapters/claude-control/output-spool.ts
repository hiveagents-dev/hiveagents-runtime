import { AgentRuntimeError } from '../../public/errors.js';
import type { AgentEvent } from '../../public/types.js';
import { stringValue } from '../provider.js';
import { readProviderRateLimits, resolveProviderRateLimits } from '../provider-limits.js';

export type PumpItem =
  | { kind: 'native'; message: Record<string, unknown> }
  | { kind: 'session'; sessionId: string }
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'terminal'; message: Record<string, unknown> };

/** Pure projection; publication is synchronous and bounded, never a UI/disk await. */
export function translateClaudeOutput(message: Record<string, unknown>, currentSession: string | undefined,
  nextToolId: () => string, publish: (item: PumpItem) => void): { sessionId?: string; account?: { plan?: string } } {
  const type = stringValue(message.type);
  const limits = resolveProviderRateLimits(readProviderRateLimits('claude', message));
  if (limits) { publish({ kind: 'event', event: { type: 'provider.event', provider: 'claude', event: limits } }); return {}; }
  if (type === 'system' && message.subtype === 'init') {
    const sessionId = stringValue(message.session_id);
    if (sessionId !== undefined && sessionId !== currentSession) publish({ kind: 'session', sessionId });
    const account = message.account;
    const metadata: { sessionId?: string; account?: { plan?: string } } = sessionId === undefined ? {} : { sessionId };
    if (typeof account === 'object' && account !== null && !Array.isArray(account)) {
      const plan = stringValue((account as Record<string, unknown>).plan); metadata.account = plan === undefined ? {} : { plan };
    }
    return metadata;
  }
  if (type === 'stream_event') {
    const nested = message.event;
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const delta = (nested as Record<string, unknown>).delta;
      if (typeof delta === 'object' && delta !== null && !Array.isArray(delta)) {
        const text = stringValue((delta as Record<string, unknown>).text);
        if (text !== undefined) { publish({ kind: 'event', event: { type: 'message.delta', text } }); return {}; }
      }
    }
  } else if (type === 'assistant') {
    const raw = message.message;
    const content = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).content : undefined;
    if (Array.isArray(content)) for (const block of content) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
      const value = block as Record<string, unknown>;
      if (value.type === 'tool_use') publish({ kind: 'event', event: { type: 'tool.started',
        id: stringValue(value.id) ?? nextToolId(), name: stringValue(value.name) ?? 'unknown',
        ...(value.input === undefined ? {} : { input: value.input }),
      } });
    }
    return {};
  } else if (type === 'result') {
    publish({ kind: 'event', event: { type: 'message.completed', text: stringValue(message.result) ?? '' } });
    publish({ kind: 'terminal', message }); return {};
  }
  publish({ kind: 'event', event: { type: 'provider.event', provider: 'claude', event: message } }); return {};
}

export function claudeQueryFailure(cause?: unknown): AgentRuntimeError {
  if (cause instanceof AgentRuntimeError) return cause;
  return new AgentRuntimeError('PROTOCOL_ERROR', cause instanceof Error
    ? `Claude control query failed: ${cause.message}` : 'Claude control query ended',
    { provider: 'claude', transport: 'control', retryable: false }, { cause });
}
