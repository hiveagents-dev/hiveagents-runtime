import { classifyClaudeFailure } from '../failure-classification.js';
import { confirmedUsageRetryAt, readProviderRateLimits, resolveProviderRateLimits } from '../provider-limits.js';
import type { AgentEvent, ModelUsage, Usage } from '../../public/types.js';
import { jsonlFrames } from '../../process/jsonl-frames.js';
import {
  numberValue,
  parseObject,
  stringValue,
  type ProtocolFailure,
  type ProtocolResult,
} from '../provider.js';


function setNumber<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  const parsed = numberValue(value);
  if (parsed !== undefined) target[key] = parsed as T[K];
}

function parseUsage(event: Record<string, unknown>): Usage | undefined {
  const rawModels = event.modelUsage;
  if (typeof rawModels === 'object' && rawModels !== null && !Array.isArray(rawModels)) {
    const perModel: Record<string, ModelUsage> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let cacheCreationTokens = 0;
    let reportedCostUsd = 0;
    for (const [model, raw] of Object.entries(rawModels)) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      const usage: ModelUsage = {};
      setNumber(usage, 'inputTokens', value.inputTokens);
      setNumber(usage, 'outputTokens', value.outputTokens);
      setNumber(usage, 'cachedInputTokens', value.cacheReadInputTokens);
      setNumber(usage, 'cacheCreationTokens', value.cacheCreationInputTokens);
      setNumber(usage, 'reportedCostUsd', value.costUSD);
      perModel[model] = usage;
      inputTokens += usage.inputTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;
      cachedInputTokens += usage.cachedInputTokens ?? 0;
      cacheCreationTokens += usage.cacheCreationTokens ?? 0;
      reportedCostUsd += usage.reportedCostUsd ?? 0;
    }
    if (Object.keys(perModel).length > 0) {
      const totalCost = numberValue(event.total_cost_usd);
      const hasReportedCost = totalCost !== undefined
        || Object.values(perModel).some((m) => m.reportedCostUsd !== undefined);
      return {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        perModel,
        // Sin costo reportado por el CLI no se inventa un 0 api-equivalent.
        ...(hasReportedCost ? { reportedCostUsd: totalCost ?? reportedCostUsd } : {}),
        costMeaning: hasReportedCost ? 'api-equivalent' : 'unavailable',
      };
    }
  }

  const rawUsage = event.usage;
  if (typeof rawUsage !== 'object' || rawUsage === null || Array.isArray(rawUsage)) return undefined;
  const value = rawUsage as Record<string, unknown>;
  const usage: Usage = {
    costMeaning: numberValue(event.total_cost_usd) === undefined ? 'unavailable' : 'api-equivalent',
  };
  setNumber(usage, 'inputTokens', value.input_tokens);
  setNumber(usage, 'outputTokens', value.output_tokens);
  setNumber(usage, 'cachedInputTokens', value.cache_read_input_tokens);
  setNumber(usage, 'cacheCreationTokens', value.cache_creation_input_tokens);
  setNumber(usage, 'reportedCostUsd', event.total_cost_usd);
  return usage;
}

/** Per-turn fallback identity counter shared by incremental line parsing. */
export interface ClaudeJsonlState { toolFallbackIndex: number }

export function parseClaudeJsonl(raw: string, state: ClaudeJsonlState = { toolFallbackIndex: 0 }): ProtocolResult {
  const events: AgentEvent[] = [];
  const nativeEvents: unknown[] = [];
  let sessionId: string | undefined;
  let text = '';
  let output: unknown;
  let usage: Usage | undefined;
  let terminalEvent: Record<string, unknown> | undefined;
  let failure: ProtocolFailure | undefined;

  for (const line of jsonlFrames(raw)) {
    if (!line.trim()) continue;
    const event = parseObject(line);
    if (!event) {
      events.push({ type: 'provider.event', provider: 'claude', event: { type: 'non-json-output', line } });
      continue;
    }
    nativeEvents.push(event);
    const limits = resolveProviderRateLimits(readProviderRateLimits('claude', event));
    if (limits) {
      events.push({ type: 'provider.event', provider: 'claude', event: limits });
      continue;
    }
    const type = stringValue(event.type);
    if (type === 'system' && event.subtype === 'init') {
      sessionId = stringValue(event.session_id) ?? sessionId;
    } else if (type === 'stream_event') {
      const nested = event.event;
      if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
        const delta = (nested as Record<string, unknown>).delta;
        if (typeof delta === 'object' && delta !== null && !Array.isArray(delta)) {
          const deltaText = stringValue((delta as Record<string, unknown>).text);
          if (deltaText !== undefined) events.push({ type: 'message.delta', text: deltaText });
          else events.push({ type: 'provider.event', provider: 'claude', event });
        }
      }
    } else if (type === 'assistant') {
      const message = event.message;
      const content = typeof message === 'object' && message !== null && !Array.isArray(message)
        ? (message as Record<string, unknown>).content
        : undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
          const value = block as Record<string, unknown>;
          if (value.type === 'tool_use') {
            events.push({
              type: 'tool.started',
              // One counter for a complete transcript or the incremental turn.
              id: stringValue(value.id) ?? `claude-tool-${state.toolFallbackIndex++}`,
              name: stringValue(value.name) ?? 'unknown',
              ...(value.input === undefined ? {} : { input: value.input }),
            });
          }
        }
      }
    } else if (type === 'result') {
      terminalEvent = event;
      sessionId = stringValue(event.session_id) ?? sessionId;
      text = stringValue(event.result) ?? '';
      output = event.structured_output;
      usage = parseUsage(event);
      events.push({ type: 'message.completed', text });
      if (event.is_error === true || event.terminal_reason === 'api_error') {
        failure = classifyClaudeFailure(event);
      }
    } else {
      events.push({ type: 'provider.event', provider: 'claude', event });
    }
  }

  if (!terminalEvent && !failure) {
    failure = { kind: 'protocol', message: 'Claude stream ended without a result event' };
  }

  const retryAt = confirmedUsageRetryAt(events);
  if (failure && terminalEvent?.api_error_status === 429 && retryAt !== undefined)
    failure = { kind: 'usage-limit', message: 'Provider usage limit reached' };
  if (failure?.kind === 'usage-limit' && retryAt !== undefined) failure = { ...failure, retryAt };

  return {
    completed: terminalEvent !== undefined && failure === undefined,
    failed: failure !== undefined,
    refused: false,
    ...(sessionId === undefined ? {} : { sessionId }),
    text,
    ...(output === undefined ? {} : { output }),
    ...(usage === undefined ? {} : { usage }),
    events,
    ...(failure === undefined ? {} : { failure }),
    ...(terminalEvent === undefined ? {} : { terminalEvent }),
    nativeEvents,
  };
}
