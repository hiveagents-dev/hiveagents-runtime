import { nativeFailureReason, nativeUsageLimit } from '../failure-classification.js';
import { confirmedUsageRetryAt, readProviderRateLimits, resolveProviderRateLimits } from '../provider-limits.js';
import type { AgentEvent, Usage } from '../../public/types.js';
import { jsonlFrames } from '../../process/jsonl-frames.js';
import {
  numberValue,
  parseObject,
  stringValue,
  type ProtocolFailure,
  type ProtocolResult,
} from '../provider.js';

export function classifyCodexFailure(messages: string[]): ProtocolFailure {
  const message = messages.join(' | ') || 'Codex turn failed';
  const normalized = message.toLowerCase();
  // El check de workspace va primero: el stderr real de codex arrastra ruido de
  // transporte MCP ("HTTP 403 UnexpectedServerResponse") incluso en runs
  // exitosos (fixtures t5-t7), y un match laxo de auth lo clasificaba mal.
  if (/not (?:inside|in) a (?:trusted )?(?:git )?(?:repository|directory)|untrusted (?:repository|workspace|directory)|git repository.*required/.test(normalized)) {
    return {
      kind: 'untrusted-workspace',
      message: `${message} (remediation: run inside a trusted git repository or set providerOptions.codex.skipGitRepoCheck)`,
    };
  }
  const reason = nativeFailureReason(message);
  if (reason === 'request-rejected' || reason === 'execution-limit') return { kind: 'provider-unavailable', message, reason };
  if (/no rollout found/.test(normalized)) return { kind: 'session-not-found', message };
  // Sólo frases inequívocas de auth del propio codex; nunca códigos HTTP
  // sueltos, que también aparecen en errores de servidores MCP ajenos.
  if (/not logged in|run codex login|codex login|authentication failed|invalid (?:api key|credentials)|token (?:has )?expired/.test(normalized)) {
    return { kind: 'not-authenticated', message };
  }
  if (/unknown model|model.*not found/.test(normalized)) return { kind: 'unknown-model', message };
  if (/model.*(?:unavailable|access|plan|tier)|not supported when using codex with a chatgpt/.test(normalized)) {
    return { kind: 'model-unavailable', message };
  }
  if (nativeUsageLimit(message)) return { kind: 'usage-limit', message };
  return { kind: 'provider-unavailable', message, ...(reason === undefined ? {} : { reason }) };
}

function parseUsage(value: unknown): Usage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: Usage = { costMeaning: 'unavailable' };
  const inputTokens = numberValue(raw.input_tokens);
  const outputTokens = numberValue(raw.output_tokens);
  const cachedInputTokens = numberValue(raw.cached_input_tokens);
  const cacheWriteInputTokens = numberValue(raw.cache_write_input_tokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteInputTokens !== undefined) usage.cacheCreationTokens = cacheWriteInputTokens;
  // reasoning_output_tokens queda sólo en terminalEvent/nativeEvents a propósito:
  // Usage no tiene campo portable para reasoning y no inventamos uno.
  return usage;
}

function itemId(item: Record<string, unknown>, index: number): string {
  return stringValue(item.id) ?? `codex-item-${index}`;
}

function toolName(item: Record<string, unknown>): string {
  const type = stringValue(item.type);
  if (type === 'command_execution') return 'shell';
  if (type === 'mcp_tool_call') return stringValue(item.tool) ?? 'mcp';
  return type ?? 'unknown';
}

/** Per-turn item ordinal, including native IDs, shared by incremental parsing. */
export interface CodexJsonlState { itemIndex: number }

export function parseCodexJsonl(raw: string, state: CodexJsonlState = { itemIndex: 0 }): ProtocolResult {
  const events: AgentEvent[] = [];
  const nativeEvents: unknown[] = [];
  const errorMessages: string[] = [];
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let text = '';
  let usage: Usage | undefined;
  let terminalEvent: Record<string, unknown> | undefined;
  let structuredThrottle = false;
  let structuredQuota = false;

  for (const line of jsonlFrames(raw)) {
    if (!line.trim()) continue;
    const event = parseObject(line);
    if (!event) {
      events.push({ type: 'provider.event', provider: 'codex', event: { type: 'non-json-output', line } });
      continue;
    }
    nativeEvents.push(event);
    const limits = resolveProviderRateLimits(readProviderRateLimits('codex', event));
    if (limits) {
      events.push({ type: 'provider.event', provider: 'codex', event: limits });
      if (limits.source === 'codex-usage-error') { structuredQuota = true; errorMessages.push('Usage limit reached'); }
      continue;
    }
    const type = stringValue(event.type);
    if (type === 'thread.started') {
      sessionId = stringValue(event.thread_id) ?? sessionId;
    } else if (type === 'turn.started') {
      turnId = stringValue(event.turn_id) ?? turnId;
      events.push(turnId === undefined ? { type: 'turn.started' } : { type: 'turn.started', turnId });
    } else if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      const item = event.item;
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const id = itemId(value, state.itemIndex++);
      const itemType = stringValue(value.type);
      if (itemType === 'agent_message' && type === 'item.completed') {
        text = stringValue(value.text) ?? text;
        events.push({ type: 'message.completed', text });
      } else if (itemType === 'error') {
        const message = stringValue(value.message) ?? 'Codex item error';
        errorMessages.push(message);
        events.push({ type: 'provider.event', provider: 'codex', event });
      } else if (['command_execution', 'mcp_tool_call', 'file_change', 'patch_apply', 'web_search'].includes(itemType ?? '')) {
        if (type === 'item.started') {
          events.push({ type: 'tool.started', id, name: toolName(value), input: value });
        } else if (type === 'item.updated') {
          events.push({ type: 'tool.updated', id, update: value });
        } else {
          events.push({ type: 'tool.completed', id, output: value });
        }
      } else {
        events.push({ type: 'provider.event', provider: 'codex', event });
      }
    } else if (type === 'turn.completed') {
      terminalEvent = event;
      usage = parseUsage(event.usage);
    } else if (type === 'turn.failed') {
      terminalEvent = event;
      errorMessages.push(stringValue(event.message) ?? 'turn.failed');
    } else if (type === 'error') {
      const code = typeof event.error === 'object' && event.error !== null
        ? (event.error as Record<string, unknown>).type ?? (event.error as Record<string, unknown>).code : undefined;
      if (code === 'rate_limit_exceeded') { structuredThrottle = true; errorMessages.push('Provider request throttled'); }
      else errorMessages.push(stringValue(event.message) ?? 'Codex error event');
      events.push({ type: 'provider.event', provider: 'codex', event });
    } else {
      events.push({ type: 'provider.event', provider: 'codex', event });
    }
  }

  let failure: ProtocolFailure | undefined;
  if (terminalEvent?.type === 'turn.failed') {
    failure = classifyCodexFailure(errorMessages);
  } else if (!terminalEvent && errorMessages.length > 0) {
    failure = classifyCodexFailure(errorMessages);
  } else if (!terminalEvent) {
    failure = { kind: 'protocol', message: 'Codex stream ended without turn.completed or turn.failed' };
  }

  const retryAt = confirmedUsageRetryAt(events);
  if (failure && structuredThrottle && !structuredQuota) failure = { kind: 'provider-unavailable', message: 'Provider request throttled' };
  if (failure?.kind === 'usage-limit' && retryAt !== undefined) failure = { ...failure, retryAt };

  return {
    completed: terminalEvent?.type === 'turn.completed' && failure === undefined,
    failed: failure !== undefined,
    refused: false,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(turnId === undefined ? {} : { turnId }),
    text,
    ...(usage === undefined ? {} : { usage }),
    events,
    ...(failure === undefined ? {} : { failure }),
    ...(terminalEvent === undefined ? {} : { terminalEvent }),
    nativeEvents,
  };
}
