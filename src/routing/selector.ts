import { rethrowExecutionHalt } from '../public/execution-halt.js';
import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Agent } from '../public/agent.js';
import { TimeoutError } from '../public/errors.js';
import type { ModelInfo } from '../public/types.js';
import { Runtime } from '../core/runtime.js';
import { authenticationState } from '../core/auth-evidence.js';
import { OperationScope } from '../control/operation-scope.js';
import { normalize } from './config.js';
import { digest, hash, identifier, method, ownObject } from '../shared/json.js';
import { sealReceipt } from './receipt.js';
import { RoutingSelectionError, type CreateAgentContext, type RoutingAgentDefinition, type RoutingCandidate, type RoutingCandidateCode, type RoutingReceipt, type RoutingReceiptStore, type RoutingSelected } from './types.js';

function failureCode(error: unknown): RoutingCandidateCode {
  // Adapter failures are untrusted: never evaluate accessors, inherited values or proxy traps.
  if (error === null || (typeof error !== 'object' && typeof error !== 'function') || types.isProxy(error)) return 'PROBE_FAILED';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  switch (code) {
    case 'CLI_NOT_INSTALLED': return 'CLI_MISSING';
    case 'NOT_AUTHENTICATED': return 'AUTH_REQUIRED';
    case 'UNEXPECTED_AUTH_SOURCE': return 'SUBSCRIPTION_REQUIRED';
    case 'UNSUPPORTED_CLI_VERSION': return 'CLI_UNSUPPORTED';
    case 'UNSUPPORTED_CAPABILITY':
    case 'REQUIRED_TRANSPORT_UNAVAILABLE': return 'POLICY_UNSUPPORTED';
    default: return 'PROBE_FAILED';
  }
}
function modelMatches(actual: ModelInfo, expected: ModelInfo): boolean {
  return actual.provider === expected.provider && actual.id === expected.id
    && actual.availability === expected.availability;
}

/** Resolve once locally. Never creates a session, dispatches a prompt, or retries execution. */
export async function createAgent(definition: RoutingAgentDefinition, context: CreateAgentContext): Promise<{ agent: Agent; receipt: RoutingReceipt }> {
  const startedAt = performance.now();
  context = ownObject(context, ['runtime', 'receipts', 'id', 'task', 'sourceDigest', 'signal', 'timeoutMs']);
  if (!context.runtime || types.isProxy(context.runtime) || !(context.runtime instanceof Runtime)) throw new TypeError('A Runtime is required');
  if (!context.receipts || typeof context.receipts !== 'object') throw new TypeError('A receipt store is required');
  const save = method<RoutingReceiptStore['save']>(context.receipts, 'save');
  method<RoutingReceiptStore['load']>(context.receipts, 'load');
  const id = context.id === undefined ? randomUUID() : context.id;
  identifier(id);
  const sourceDigest = context.sourceDigest;
  if (sourceDigest !== undefined) hash(sourceDigest);
  const timeoutMs = context.timeoutMs === undefined ? 30000 : context.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RangeError('Invalid selection timeoutMs');
  const signal = context.signal;
  if (signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal))) throw new TypeError('Invalid AbortSignal');
  const expires = startedAt + timeoutMs;
  const scope = new OperationScope({ timeoutMs: Math.max(1, Math.floor(expires - performance.now())), ...(signal === undefined ? {} : { signal }) });
  const cancellationCode = (): 'ABORTED' | 'TIMEOUT' | undefined => {
    if (scope.signal.aborted) return (scope.signal.reason as { code?: string }).code === 'TIMEOUT' ? 'TIMEOUT' : 'ABORTED';
    if (performance.now() >= expires || scope.remainingMs() < 1) return 'TIMEOUT';
    return undefined;
  };
  const assertActive = (): void => {
    if (scope.signal.aborted) throw scope.signal.reason;
    if (cancellationCode()) throw new TimeoutError({ retryable: true }, 'Selection deadline exceeded');
  };
  const check = () => scope.race(assertActive);
  try {
    const runtime = context.runtime;
    // The deadline already exists while provider resolution and schema validation run.
    const config = normalize(definition, runtime, context.task);
    const candidates: RoutingCandidate[] = config.models.map(model => ({
      model: `${model.provider}/${model.id}`, provider: model.provider, modelId: model.id,
      status: 'not-evaluated',
      code: config.primary.includes(`${model.provider}/${model.id}`) || config.fallback === `${model.provider}/${model.id}` ? 'NOT_NEEDED' : 'NOT_IN_RULE',
    }));
    const excluded = (candidate: RoutingCandidate, code: RoutingCandidateCode) => { candidate.status = 'excluded'; candidate.code = code; };
    // Static hard filters cover the entire closed universe, even candidates never probed.
    candidates.forEach((candidate, index) => {
      const model = config.models[index]!;
      if (config.auto?.providers && !config.auto.providers.includes(candidate.provider)) excluded(candidate, 'PROVIDER_NOT_ALLOWED');
      else if (model.availability === 'unavailable') excluded(candidate, 'MODEL_UNAVAILABLE');
      else if (config.auto && model.availability === 'unverified' && !config.auto.allowUnverifiedModels) excluded(candidate, 'MODEL_UNVERIFIED');
    });
    let selected: RoutingSelected | undefined;
    let agent: Agent | undefined;
    let reason: RoutingReceipt['reason'] = candidates.length === 0 ? 'NO_CANDIDATES'
      : config.auto?.rules && !config.ruleId && !config.fallback ? 'NO_MATCHING_RULE' : 'NO_ELIGIBLE_CANDIDATE';
    let fatal: 'ABORTED' | 'TIMEOUT' | undefined;
    const cancelProposal = (code: 'ABORTED' | 'TIMEOUT') => {
      fatal = code; reason = code; selected = undefined; agent = undefined;
      for (const candidate of candidates) if (candidate.status === 'eligible') excluded(candidate, code);
    };
    try {
      await check();
      for (const name of [...config.primary, ...(config.fallback === undefined ? [] : [config.fallback])]) {
        await check();
        const index = candidates.findIndex(entry => entry.model === name);
        const candidate = candidates[index]!;
        const expected = config.models[index]!;
        if (candidate.status === 'excluded') continue;
        try {
          assertActive();
          const prepared = new Agent({ ...config.options, model: name }, runtime);
          if (!modelMatches(prepared.model, expected)) { excluded(candidate, 'PROBE_FAILED'); continue; }
          assertActive();
          // Await raw readiness: ownership lasts until actual preparation settles.
          const ready = await prepared.ready({ signal: scope.signal, timeoutMs: Math.max(1, Math.min(scope.remainingMs(), Math.floor(expires - performance.now()))), awaitSettlement: true });
          await check();
          if (!modelMatches(prepared.model, expected) || !modelMatches(ready.model, expected) || ready.provider !== candidate.provider) {
            excluded(candidate, 'PROBE_FAILED'); continue;
          }
          candidate.authState = authenticationState(ready.auth); candidate.authSource = ready.auth.source;
          candidate.transport = ready.plan.transport; candidate.fingerprintDigest = digest(ready.plan);
          if (ready.capabilities.unsupported.length) { excluded(candidate, 'POLICY_UNSUPPORTED'); continue; }
          if (candidate.authState === 'not-authenticated') { excluded(candidate, 'AUTH_REQUIRED'); continue; }
          if (config.auto && candidate.authState === 'unknown' && !config.auto.allowUnknownAuth) { excluded(candidate, 'AUTH_UNKNOWN'); continue; }
          if (!ready.ready || !ready.installation.installed) { excluded(candidate, 'CLI_MISSING'); continue; }
          candidate.status = 'eligible'; candidate.code = 'READY'; agent = prepared;
          selected = { model: name, provider: candidate.provider, modelId: candidate.modelId, transport: candidate.transport, fingerprintDigest: candidate.fingerprintDigest };
          reason = !config.auto ? 'FIXED' : name === config.fallback ? 'FALLBACK' : config.ruleId ? 'RULE' : 'PRIORITY';
          break;
        } catch (error) {
          rethrowExecutionHalt(error);
          const cancelled = cancellationCode();
          if (cancelled) { excluded(candidate, cancelled); throw error; }
          excluded(candidate, failureCode(error));
        }
      }
      await check();
    } catch (error) {
      rethrowExecutionHalt(error);
      const cancelled = cancellationCode();
      if (!cancelled) throw error;
      cancelProposal(cancelled);
    }
    await scope.drain();
    const beforeSave = cancellationCode();
    if (beforeSave) cancelProposal(beforeSave);
    const makeReceipt = () => sealReceipt({
      format: 1, purpose: 'selection-proposal', id, createdAt: Date.now(), configDigest: config.configDigest, taskDigest: config.taskDigest,
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      policy: { mode: config.auto ? 'auto' : 'fixed', version: 'priority-v1', ...(config.ruleId === undefined ? {} : { ruleId: config.ruleId }) },
      decision: selected ? 'selected' : 'abstained', reason, candidates, nativeDispatches: 0, ...(selected === undefined ? {} : { selected }),
    });
    let receipt = makeReceipt();
    const afterSeal = cancellationCode();
    if (!fatal && afterSeal) { cancelProposal(afterSeal); receipt = makeReceipt(); }
    // Never race immutable IO: raw rejection wins over later cancellation.
    await save(receipt);
    if (!fatal) {
      try { await check(); } catch { fatal = cancellationCode() ?? 'ABORTED'; }
    }
    await scope.drain();
    const identityMatches = agent && selected && modelMatches(agent.model, config.models[candidates.findIndex(candidate => candidate.model === selected!.model)]!);
    // This synchronous gate follows the LAST await. Cleanup and return cannot yield.
    const atReturn = cancellationCode();
    if (atReturn) fatal = atReturn;
    if (fatal) throw new RoutingSelectionError(fatal, receipt);
    if (!agent || !identityMatches) throw new RoutingSelectionError('NO_ROUTE', receipt);
    scope.dispose();
    return { agent, receipt };
  } finally { scope.dispose(); }
}
