import { stringValue, type ProtocolFailure } from './provider.js';

/** Only native failure records/stderr enter here, never successful tool/MCP notices. */
export function nativeFailureReason(message: string, code?: string): ProtocolFailure['reason'] {
  // A rejected request cannot be repaired by replaying it at another provider.
  if (/too long|context (?:window|length)|invalid_request|\b400\b|polic(?:y|ies)|flagged|content filter|safety/i.test(message)) return 'request-rejected';
  if (['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(code ?? '')) return 'execution-limit';
  if (/overloaded|\b529\b|\b503\b|service unavailable/i.test(message)) return 'provider-overloaded';
  if (/exited with code|\b5\d\d\b|\bECONN\w*|\bETIMEDOUT\b|\bEPIPE\b|socket hang up|stream (?:ended|closed|disconnected)|disconnected|timed? ?out connecting|connection (?:reset|refused|closed)|bad gateway|internal server error/i.test(message)) return 'transport';
  return undefined;
}

export const nativeUsageLimit = (message: string): boolean =>
  /\b(?:usage|rate|weekly|daily|session|monthly)[ -]limit|\bhit your (?:\w+ )?limit|\blimit reached|\bquota(?: exceeded)?\b/i.test(message);

/** Shared by Claude exec and control so public failure semantics do not depend on transport. */
export function classifyClaudeFailure(event: Record<string, unknown>): ProtocolFailure {
  const errors = Array.isArray(event.errors) ? event.errors.filter(item => typeof item === 'string').join(' | ') : '';
  const message = stringValue(event.result) ?? (errors || 'Claude turn failed');
  const rawCode = stringValue(event.terminal_reason) ?? stringValue(event.subtype);
  const base = { message, ...(rawCode === undefined ? {} : { rawCode }) };
  const reason = nativeFailureReason(message, rawCode);
  if (reason === 'request-rejected' || reason === 'execution-limit') return { kind: 'provider-unavailable', reason, ...base };
  if (/no conversation found/i.test(message)) return { kind: 'session-not-found', ...base };
  if (/not logged in|please run \/login|unauthenticated/i.test(message)) return { kind: 'not-authenticated', ...base };
  if (/unrecognized.model|unknown.model|model.*not found/i.test(message)) return { kind: 'unknown-model', ...base };
  if (/model.*(?:unavailable|access|plan|tier)/i.test(message)) return { kind: 'model-unavailable', ...base };
  if (nativeUsageLimit(message)) return { kind: 'usage-limit', ...base };
  return { kind: 'provider-unavailable', ...base, ...(reason === undefined ? {} : { reason }) };
}
