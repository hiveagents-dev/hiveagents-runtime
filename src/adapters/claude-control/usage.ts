import type { ModelUsage, Usage } from '../../public/types.js';
import { numberValue } from '../provider.js';

function setNumber<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  const parsed = numberValue(value);
  if (parsed !== undefined) target[key] = parsed as T[K];
}

/**
 * Usage acumulado del envelope de un result message del Agent SDK. Igual que
 * en exec (§11.1): `usage` llega en snake_case y `modelUsage` en camelCase.
 */
export function parseCumulativeUsage(event: Record<string, unknown>): Usage | undefined {
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

function delta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  return Math.max(0, current - (previous ?? 0));
}

function withDelta<T extends object, K extends keyof T>(
  target: T,
  key: K,
  current: number | undefined,
  previous: number | undefined,
): void {
  const value = delta(current, previous);
  if (value !== undefined) target[key] = value as T[K];
}

/**
 * Un query long-lived reporta usage acumulado por sesión en cada result; el
 * usage por turn es la diferencia contra el acumulado del turn anterior.
 */
export function diffTurnUsage(previous: Usage | undefined, current: Usage | undefined): Usage | undefined {
  if (current === undefined) return undefined;
  if (previous === undefined) return current;
  const usage: Usage = { costMeaning: current.costMeaning };
  withDelta(usage, 'inputTokens', current.inputTokens, previous.inputTokens);
  withDelta(usage, 'outputTokens', current.outputTokens, previous.outputTokens);
  withDelta(usage, 'cachedInputTokens', current.cachedInputTokens, previous.cachedInputTokens);
  withDelta(usage, 'cacheCreationTokens', current.cacheCreationTokens, previous.cacheCreationTokens);
  withDelta(usage, 'reportedCostUsd', current.reportedCostUsd, previous.reportedCostUsd);
  if (current.perModel !== undefined) {
    const perModel: Record<string, ModelUsage> = {};
    for (const [model, modelUsage] of Object.entries(current.perModel)) {
      const before = previous.perModel?.[model];
      const diffed: ModelUsage = {};
      withDelta(diffed, 'inputTokens', modelUsage.inputTokens, before?.inputTokens);
      withDelta(diffed, 'outputTokens', modelUsage.outputTokens, before?.outputTokens);
      withDelta(diffed, 'cachedInputTokens', modelUsage.cachedInputTokens, before?.cachedInputTokens);
      withDelta(diffed, 'cacheCreationTokens', modelUsage.cacheCreationTokens, before?.cacheCreationTokens);
      withDelta(diffed, 'reportedCostUsd', modelUsage.reportedCostUsd, before?.reportedCostUsd);
      if (Object.values(diffed).some((value) => value !== undefined && value > 0) || before === undefined) {
        perModel[model] = diffed;
      }
    }
    if (Object.keys(perModel).length > 0) usage.perModel = perModel;
  }
  return usage;
}
