import { rethrowExecutionHalt } from '../../public/execution-halt.js';
import { Agent } from '../../public/agent.js';
import { authenticationState } from '../../core/auth-evidence.js';
import type { AgentReadiness, ModelInfo } from '../../public/types.js';
import type { OperationScope } from '../../control/operation-scope.js';
import { digest, freeze, snapshot } from '../../shared/json.js';
import type { RoutingCandidateCode } from '../types.js';
import { assertActive, safeCode, type CapturedSelection } from './factory-context.js';
import type { LearningAction, LearningCandidate, LearningPreflight } from './types.js';
export interface PreparedSelection {
    preflight: LearningPreflight;
    agents: ReadonlyMap<string, Agent>;
    readiness: ReadonlyMap<string, AgentReadiness>;
}
function probeCode(error: unknown): RoutingCandidateCode {
    switch (safeCode(error)) {
        case 'CLI_NOT_INSTALLED': return 'CLI_MISSING';
        case 'NOT_AUTHENTICATED': return 'AUTH_REQUIRED';
        case 'UNEXPECTED_AUTH_SOURCE': return 'SUBSCRIPTION_REQUIRED';
        case 'UNSUPPORTED_CLI_VERSION': return 'CLI_UNSUPPORTED';
        case 'UNSUPPORTED_CAPABILITY':
        case 'REQUIRED_TRANSPORT_UNAVAILABLE': return 'POLICY_UNSUPPORTED';
        default: return 'PROBE_FAILED';
    }
}
export function modelMatches(actual: ModelInfo, expected: ModelInfo): boolean {
    const a = snapshot(actual);
    return a.provider === expected.provider && a.id === expected.id && a.availability === expected.availability;
}
/** No raw paths, auth material or authority tokens enter persisted evidence. */
export function executionDigest(readiness: AgentReadiness): string {
    const ready = snapshot(readiness);
    const { authorityEpoch: _epoch, ...envelope } = ready.plan.envelope;
    return digest({ provider: ready.provider, model: `${ready.model.provider}/${ready.model.id}`, transport: ready.plan.transport,
        fingerprint: ready.plan.fingerprint, capabilities: ready.plan.capabilities, envelope,
        auth: { source: ready.auth.source, state: authenticationState(ready.auth) } });
}
/** Preserve the exec adapter's existing distinction between unknown and unsupported features. */
export function supportsOutputContract(captured: CapturedSelection, ready: AgentReadiness): boolean {
    if (captured.outputSchema === undefined)
        return true;
    const feature = ready.capabilities.features?.structuredOutput;
    const negotiated = ready.plan.capabilities.structuredOutput?.support;
    return ready.plan.transport === 'exec' && feature !== 'partial' && feature !== 'unsupported' &&
        negotiated !== 'partial' && negotiated !== 'none';
}

export async function prepareSelection(captured: CapturedSelection, domain: string, scope: OperationScope): Promise<PreparedSelection> {
    const candidates: LearningCandidate[] = captured.arms.map(a => ({ id: a.id, model: `${a.model.provider}/${a.model.id}`, provider: a.model.provider, modelId: a.model.id, status: 'not-evaluated', code: 'NOT_NEEDED' }));
    const agents = new Map<string, Agent>(), readiness = new Map<string, AgentReadiness>();
    // All static filters apply before any adapter probe, including evaluation overrides.
    candidates.forEach((candidate, index) => {
        const arm = captured.arms[index]!;
        let code: RoutingCandidateCode | undefined;
        if (captured.auto?.providers && !captured.auto.providers.includes(candidate.provider))
            code = 'PROVIDER_NOT_ALLOWED';
        else if (arm.model.availability === 'unavailable')
            code = 'MODEL_UNAVAILABLE';
        else if (captured.auto && arm.model.availability === 'unverified' && !captured.auto.allowUnverifiedModels)
            code = 'MODEL_UNVERIFIED';
        if (code) {
            candidate.status = 'excluded';
            candidate.code = code;
        }
    });
    assertActive(scope);
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!, arm = captured.arms[index]!;
        if (candidate.status === 'excluded')
            continue;
        assertActive(scope);
        try {
            const agent = new Agent({ ...arm.options, model: candidate.model }, captured.runtime);
            if (!modelMatches(agent.model, arm.model)) {
                candidate.status = 'excluded';
                candidate.code = 'PROBE_FAILED';
                continue;
            }
            // Await raw preparation settlement, including on cancellation.
            const ready = snapshot(await agent.ready({ signal: scope.signal, timeoutMs: Math.max(1, scope.remainingMs()), awaitSettlement: true }));
            assertActive(scope);
            if (!modelMatches(agent.model, arm.model) || !modelMatches(ready.model, arm.model) || ready.provider !== candidate.provider)
                throw new TypeError('Readiness model changed');
            const auth = authenticationState(ready.auth);
            let code: RoutingCandidateCode | undefined;
            if (ready.capabilities.unsupported.length || !supportsOutputContract(captured, ready))
                code = 'POLICY_UNSUPPORTED';
            else if (auth === 'not-authenticated')
                code = 'AUTH_REQUIRED';
            else if (captured.auto && auth === 'unknown' && !captured.auto.allowUnknownAuth)
                code = 'AUTH_UNKNOWN';
            else if (!ready.ready || !ready.installation.installed)
                code = 'CLI_MISSING';
            if (code) {
                candidate.status = 'excluded';
                candidate.code = code;
                continue;
            }
            const identity = { model: candidate.model, provider: candidate.provider, modelId: candidate.modelId, optionsDigest: arm.optionsDigest, executionDigest: executionDigest(ready), evidenceScope: arm.evidenceScope };
            const action: LearningAction = freeze({ id: candidate.id, ...identity, key: digest(identity) });
            candidate.action = action;
            candidate.status = 'eligible';
            candidate.code = 'READY';
            agents.set(action.key, agent);
            readiness.set(action.key, ready);
        }
        catch (error) {
            rethrowExecutionHalt(error);
            assertActive(scope);
            candidate.status = 'excluded';
            candidate.code = probeCode(error);
        }
    }
    assertActive(scope);
    const actions = candidates.flatMap(c => c.action ? [c.action] : []);
    if (new Set(actions.map(a => a.key)).size !== actions.length)
        throw new TypeError('Duplicate canonical action');
    return { preflight: freeze({ domain, definitionDigest: captured.definitionDigest, candidates, actions, ...(captured.fallbackId === undefined ? {} : { fallbackId: captured.fallbackId }) }), agents, readiness };
}
