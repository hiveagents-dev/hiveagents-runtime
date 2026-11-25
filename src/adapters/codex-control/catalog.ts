import { ProtocolError } from '../../public/errors.js';
import type { ModelCatalog, ModelInfo } from '../../public/types.js';
import { stringValue } from '../provider.js';
import type { CodexRequester } from './requester.js';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * model/list wrapper. A listed catalog means 'advertised', never confirmed
 * entitlement, so every model is reported availability:'unverified'.
 */
export async function listModels(requester: CodexRequester): Promise<ModelCatalog> {
  const result = await requester.request('model/list', {});
  const raw = asObject(result);
  const entries = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : undefined;
  if (entries === undefined) {
    throw new ProtocolError(
      { provider: 'codex', transport: 'control', retryable: false },
      'Codex model/list response did not include a model array',
    );
  }
  const models: ModelInfo[] = [];
  for (const entry of entries) {
    const item = asObject(entry);
    const id = stringValue(item?.id);
    if (item === undefined || id === undefined) continue;
    const displayName = stringValue(item.displayName ?? item.display_name);
    const efforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.flatMap((value) => {
          // Current App Server returns descriptors; retain legacy string catalogs.
          const effort = stringValue(typeof value === 'string' ? value : asObject(value)?.reasoningEffort);
          return effort === undefined ? [] : [effort];
        })
      : undefined;
    models.push({
      id,
      provider: 'codex',
      aliases: [],
      source: 'app-server',
      availability: 'unverified',
      ...(displayName === undefined ? {} : { displayName }),
      ...(efforts === undefined || efforts.length === 0 ? {} : { supportedEffort: efforts }),
    });
  }
  return { provider: 'codex', source: 'app-server', models, fetchedAt: new Date().toISOString() };
}

export interface RedactedCodexAccount {
  plan?: string;
  authMethod?: string;
}

const PLAN_KEYS = new Set(['plan', 'plantype', 'plan_type']);
const AUTH_KEYS = new Set(['authmode', 'auth_mode', 'authmethod', 'auth_method']);

function scan(value: unknown, keys: ReadonlySet<string>, depth: number): string | undefined {
  if (depth > 4) return undefined;
  const raw = asObject(value);
  if (!raw) return undefined;
  for (const [key, entry] of Object.entries(raw)) {
    if (keys.has(key.toLowerCase()) && typeof entry === 'string') return entry;
  }
  for (const entry of Object.values(raw)) {
    const found = scan(entry, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * account/read wrapper with redaction: only plan-level information survives.
 * The raw payload (emails, org/account ids, tokens) is scanned for the two
 * whitelisted fields and then dropped — it never crosses this boundary.
 */
export async function readAccount(requester: CodexRequester): Promise<RedactedCodexAccount> {
  const result = await requester.request('account/read', {});
  const plan = scan(result, PLAN_KEYS, 0);
  const authMethod = scan(result, AUTH_KEYS, 0);
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(authMethod === undefined ? {} : { authMethod }),
  };
}
