#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseCaptureJson } from './lib/provider-reset-json.mjs';

const MAX_INPUT = 16_777_216, MAX_FRAME = 1_048_576, MAX_RECORDS = 100_000, MAX_OBSERVATIONS = 64;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000;
const finite = (value, allowed) => allowed.includes(value) ? value : 'unrecognized';
const reset = value => integer(value) ? { value, unit: 'unverified' } : undefined;
const knownCodes = ['credits_required', 'usage_limit_reached', 'rate_limit_exceeded',
  'insufficient_quota', 'overloaded_error'];
const transports = { claude: ['claude-stream-json', 'claude-session-observation'],
  codex: ['codex-exec-json', 'codex-app-server', 'codex-session-observation'] };

function window(value, lane, camel = false) {
  if (!record(value)) return undefined;
  const output = { lane };
  const used = value[camel ? 'usedPercent' : 'used_percent'];
  const minutes = value[camel ? 'windowDurationMins' : 'window_minutes'];
  const at = reset(value[camel ? 'resetsAt' : 'resets_at']);
  if (percent(used)) output.usedPercent = used;
  if (integer(minutes) && minutes <= 525_600) output.windowMinutes = minutes;
  if (at) output.reset = at;
  return output;
}

/** Closed DATA projection. It neither infers quota availability nor authorizes retry/release. */
export function projectProviderReset(row, provider) {
  if (!record(row)) return undefined;
  if (provider === 'claude' && row.type === 'rate_limit_event' && record(row.rate_limit_info)) {
    const info = row.rate_limit_info, item = { shape: 'claude.rate_limit_event',
      classification: 'structured-window-state', status: finite(info.status, ['allowed', 'allowed_warning', 'rejected']),
      windows: [{ lane: finite(info.rateLimitType, ['five_hour', 'seven_day', 'seven_day_opus',
        'seven_day_sonnet', 'seven_day_oauth_apps', 'overage']) }] };
    const at = reset(info.resetsAt); if (at) item.windows[0].reset = at;
    if (typeof info.utilization === 'number' && info.utilization >= 0 && info.utilization <= 1000)
      item.windows[0].utilization = info.utilization;
    if (knownCodes.includes(info.errorCode)) item.providerCode = info.errorCode;
    return item;
  }
  let limits, camel = false, shape;
  if (provider === 'codex' && row.type === 'event_msg' && record(row.payload) && row.payload.type === 'token_count') {
    limits = row.payload.rate_limits; shape = 'codex.event_msg.token_count';
  } else if (provider === 'codex' && row.type === 'token_count') {
    limits = row.rate_limits; shape = 'codex.token_count';
  } else if (provider === 'codex' && row.method === 'account/rateLimits/updated' && record(row.params)) {
    limits = row.params.rateLimits; camel = true; shape = 'codex.account.rateLimits.updated';
  }
  if (record(limits)) return { shape, classification: 'structured-window-state',
    windows: ['primary', 'secondary'].map(lane => window(limits[lane], lane, camel)).filter(Boolean) };
  if (row.type !== 'error') return undefined;
  const error = record(row.error) ? row.error : Object.create(null);
  const code = knownCodes.includes(error.code) ? error.code : knownCodes.includes(error.type) ? error.type : undefined;
  const httpStatus = [429, 503, 529].includes(row.status_code) ? row.status_code
    : [429, 503, 529].includes(error.status_code) ? error.status_code : undefined;
  if (!code && !httpStatus) return undefined;
  const classification = code === 'usage_limit_reached' || code === 'insufficient_quota' ? 'structured-usage-limit'
    : httpStatus === 529 || httpStatus === 503 || code === 'overloaded_error' ? 'provider-overload'
    : httpStatus === 429 || code === 'rate_limit_exceeded' ? 'http-rate-limit' : 'unclassified';
  const output = { shape: `${provider}.error`, classification, windows: [] };
  if (code) output.providerCode = code;
  if (httpStatus) output.httpStatus = httpStatus;
  if (integer(error.retry_after) && error.retry_after <= 604_800) output.retryAfterSeconds = error.retry_after;
  const at = reset(error.resets_at); if (at) output.windows.push({ lane: 'error', reset: at });
  return output;
}

function metadata(options) {
  const { provider, cliVersion, transport, origin, observedAt = new Date().toISOString() } = options;
  if (!Object.hasOwn(transports, provider) || !transports[provider].includes(transport)
    || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(cliVersion)
    || !['existing-capture', 'operator-opt-in-stream', 'synthetic-fixture'].includes(origin)
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt)
    throw new Error('Capture refused: invalid metadata');
  return { provider, cliVersion, cliVersionEvidence: 'operator-supplied', transport, origin, observedAt,
    observedAtEvidence: options.observedAt === undefined ? 'capture-clock' : 'operator-supplied' };
}

export async function captureProviderReset(chunks, options) {
  const meta = metadata(options), hash = createHash('sha256'), observations = [];
  const decoder = new TextDecoder('utf-8', { fatal: true }), pending = Buffer.alloc(MAX_FRAME);
  let bytes = 0, frames = 0, pendingBytes = 0;
  const accept = () => {
    if (pendingBytes === 0) return;
    if (++frames > MAX_RECORDS) throw new Error('Capture refused: record limit');
    let row;
    try { row = parseCaptureJson(decoder.decode(pending.subarray(0, pendingBytes))); }
    catch { throw new Error('Capture refused: invalid JSONL'); }
    pending.fill(0, 0, pendingBytes); pendingBytes = 0;
    const item = projectProviderReset(row, meta.provider);
    if (item) {
      if (observations.length === MAX_OBSERVATIONS) throw new Error('Capture refused: observation limit');
      observations.push({ record: frames, ...item });
    }
  };
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Capture refused: byte input required');
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    bytes += buffer.length; if (bytes > MAX_INPUT) throw new Error('Capture refused: input limit');
    hash.update(buffer);
    let start = 0;
    for (let end = 0; end <= buffer.length; end++) {
      if (end !== buffer.length && buffer[end] !== 10) continue;
      const part = buffer.subarray(start, end);
      if (pendingBytes + part.length > MAX_FRAME) throw new Error('Capture refused: frame limit');
      pending.set(part, pendingBytes); pendingBytes += part.length;
      if (end !== buffer.length) accept();
      start = end + 1;
    }
  }
  accept();
  return { schemaVersion: 1, kind: 'provider-reset-observation', ...meta,
    source: { sha256: hash.digest('hex'), bytes, frames },
    limits: { maxInputBytes: MAX_INPUT, maxFrameBytes: MAX_FRAME, maxRecords: MAX_RECORDS,
      maxObservations: MAX_OBSERVATIONS }, observations,
    interpretation: { timestampUnits: 'unverified', exhaustionProven: false,
      resetObservedToRestoreAccess: false, ledgerMutation: false } };
}

async function main() {
  const args = process.argv.slice(2), options = {}, names = {
    '--provider': 'provider', '--cli-version': 'cliVersion', '--transport': 'transport',
    '--origin': 'origin', '--observed-at': 'observedAt' };
  if (args.shift() !== '--opt-in') throw new Error('Capture refused: explicit --opt-in required');
  while (args.length) {
    const key = names[args.shift()];
    if (!key || Object.hasOwn(options, key) || !args.length) throw new Error('Capture refused: invalid metadata');
    options[key] = args.shift();
  }
  // One bounded input only; no child process, file discovery, network or raw persistence.
  const timeout = setTimeout(() => { process.stdin.destroy(new Error('Capture refused: input deadline')); }, 1_800_000);
  try { process.stdout.write(JSON.stringify(await captureProviderReset(process.stdin, options)) + '\n'); }
  finally { clearTimeout(timeout); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const allowed = ['explicit --opt-in required', 'invalid metadata', 'record limit', 'invalid JSONL',
      'observation limit', 'byte input required', 'input limit', 'frame limit', 'input deadline'];
    const safe = allowed.some(message => error?.message === `Capture refused: ${message}`)
      ? error.message : 'Capture refused: input failure';
    process.stderr.write(safe + '\n'); process.exitCode = 1;
  });
}
