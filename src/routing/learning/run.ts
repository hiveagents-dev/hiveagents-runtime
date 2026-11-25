import { isExecutionHalted } from '../../public/execution-halt.js';
import { assertCallerActive, runMaintenance } from './run-maintenance.js';
import type { LearningPreflight } from './types.js';
import { assertEpisodeGeneration, inspectRunPlan, validatePreparedPlan } from './run-plan.js';
import type { Agent } from '../../public/agent.js';
import type { AgentEvent, Turn, TurnOptions, Usage } from '../../public/types.js';
import { runObservedTask } from '../../orchestration/tasks/index.js';
import { digest, method, ownObject, snapshot } from '../../shared/json.js';
import { policyBinding } from './factory-binding.js';
import { assertActive, createScope, safeCode } from './factory-context.js';
import { decide, LearningSelectionError } from './factory-decision.js';
import { executionDigest, modelMatches, supportsOutputContract } from './factory.js';
import type { CapturedRun } from './run-context.js';
import { combineFailure, errorUsage, immutableTurn, turnEvidence, type RunFailure } from './run-evidence.js';
import type { RouterState } from './router-state.js';
import { saveShadow } from './snapshot.js';
import { sealLearningRecord } from './validation.js';
import type { LearningAttempt, LearningDecision, LearningObservation, LearningQuality, LearningRunResult, LearningSnapshot } from './types.js';
export async function executeRun(state: RouterState, captured: CapturedRun, startedAt: number): Promise<LearningRunResult> {
    const c = captured.selection, scope = createScope(c, startedAt);
    let release: (() => void | Promise<void>) | undefined;
    let agent: Agent | undefined, receipt: LearningDecision | undefined, attempt: LearningAttempt | undefined;
    let turn: Turn | undefined, shadow: LearningSnapshot | undefined, observation: LearningObservation | undefined;
    let failure: RunFailure | undefined, outcome: LearningObservation['outcome'] = 'failed';
    let quality: LearningQuality = { state: 'unknown', reason: 'RUN_FAILED' };
    let nativeCompleted = false, admissionRefused = false;
    let preflight: LearningPreflight | undefined;
    let dispatchedAt: number | undefined, durationMs: number | undefined, identityAfter: string | undefined;
    let usage: Usage | undefined, observedModels: readonly string[] | undefined;
    const splitMetadata = { ...(captured.episodeId === undefined ? {} : { episodeId: captured.episodeId }), ...(captured.repetition === undefined ? {} : { repetition: captured.repetition }) };
    const settleReservation = async () => {
        const settle = release; release = undefined;
        try { await settle?.(); }
        catch (error) {
            failure = combineFailure(failure, error);
            outcome = 'failed'; quality = { state: 'unknown', reason: 'RELEASE_FAILED' };
        }
    };
    try {
        assertActive(scope);
        const plan = await inspectRunPlan(state, captured);
        assertActive(scope);
        const reservation = await captured.acquire(scope.signal);
        release = method<() => void | Promise<void>>(reservation, 'release');
        assertActive(scope);
        const chosen = await decide(state, c, scope);
        agent = chosen.agent;
        receipt = chosen.receipt;
        preflight = chosen.prepared.preflight;
        await validatePreparedPlan(state, plan, preflight);
        assertActive(scope);
        if (captured.expectedBinding !== undefined && digest(captured.expectedBinding) !== digest(policyBinding(c, preflight)))
            throw new TypeError('Expected learning binding differs from the prepared action universe');
        const action = receipt.selected!;
        attempt = sealLearningRecord('attempt', { format: 1, id: plan.attemptId, observationId: plan.observationId, domain: state.domain, decisionId: receipt.id, decisionDigest: receipt.digest,
            action, taskDigest: c.taskDigest, features: c.features, split: captured.split, ...splitMetadata, startedAt: Date.now() });
        // A conflicting durable start stops here. It must never produce a second dispatch.
        await state.store.put('attempt', attempt.id, attempt);
        try {
            assertActive(scope);
            outcome = 'identity-drift';
            const before = snapshot(await agent.ready({ signal: scope.signal, timeoutMs: Math.max(1, scope.remainingMs()), awaitSettlement: true }));
            assertActive(scope);
            const expected = c.arms.find(a => a.id === action.id)!;
            if (!modelMatches(agent.model, expected.model) || !modelMatches(before.model, expected.model) || before.provider !== action.provider
                || before.ready !== true || before.installation.installed !== true || before.capabilities.unsupported.length > 0 || !supportsOutputContract(c, before) || executionDigest(before) !== action.executionDigest) {
                outcome = 'identity-drift';
                throw new Error('Learning action identity changed before execution');
            }
            if (before.plan.transport !== 'exec')
                throw new Error('Learning runs require exec transport');
            outcome = 'failed';
            if (plan.episode) {
                await assertEpisodeGeneration(state, plan.episode);
                assertActive(scope);
            }
            const owner = agent;
            const starter = { stream(input: string, options: TurnOptions): AsyncIterable<AgentEvent> {
                    assertActive(scope);
                    dispatchedAt = performance.now();
                    return (async function* (): AsyncIterable<AgentEvent> {
                        let invalidTerminal: RunFailure | undefined;
                        try {
                            for await (const event of owner.stream(input, options)) {
                                if (event.type !== 'turn.completed') { yield event; continue; }
                                // Freeze synchronously while consuming the event, before the provider resumes.
                                let frozen: Turn;
                                try { frozen = immutableTurn(event.turn); }
                                catch (error) { invalidTerminal = combineFailure(invalidTerminal, error); continue; }
                                yield { type: 'turn.completed', turn: frozen };
                            }
                        } catch (error) {
                            if (invalidTerminal) throw new AggregateError([error, invalidTerminal.error], 'Provider stream and terminal snapshot failed');
                            throw error;
                        }
                        // Invalid terminal metadata cannot stop actual provider cleanup from settling.
                        if (invalidTerminal) throw invalidTerminal.error;
                    })();
                } };
            const completed = await runObservedTask(starter, captured.input, {
                signal: scope.signal, timeoutMs: Math.max(1, scope.remainingMs()), awaitSettlement: true,
                ...(c.outputSchema === undefined ? {} : { outputSchema: c.outputSchema }),
            });
            durationMs = Math.max(0, performance.now() - dispatchedAt!);
            nativeCompleted = true;
            turn = completed;
            assertActive(scope);
            const evidence = turnEvidence(turn, action, before, c.cwd);
            if (evidence.status === 'interrupted')
                nativeCompleted = false;
            usage = evidence.usage;
            observedModels = evidence.observedModels;
            outcome = 'identity-drift';
            const after = snapshot(await agent.ready({ signal: scope.signal, timeoutMs: Math.max(1, scope.remainingMs()), awaitSettlement: true }));
            identityAfter = executionDigest(after);
            assertActive(scope);
            if (!modelMatches(agent.model, expected.model) || !modelMatches(after.model, expected.model) || after.provider !== action.provider
                || after.ready !== true || after.installation.installed !== true || after.capabilities.unsupported.length > 0 || !supportsOutputContract(c, after) || identityAfter !== action.executionDigest || evidence.mismatch) {
                outcome = 'identity-drift';
                throw new Error('Learning action identity changed after execution');
            }
            if (evidence.status !== 'completed') {
                outcome = evidence.status === 'refused' ? 'refused' : evidence.status === 'interrupted' ? 'aborted' : 'failed';
                throw new Error(`Learning turn ${outcome}`);
            }
            outcome = 'verifier-error';
            const verified = ownObject(snapshot(await captured.verify(turn)), ['value', 'passed']);
            assertActive(scope);
            if (typeof verified.value !== 'number' || !Number.isFinite(verified.value) || verified.value < 0 || verified.value > 1 || typeof verified.passed !== 'boolean')
                throw new TypeError('Invalid verifier result');
            quality = { state: 'verified', value: verified.value, passed: verified.passed };
            outcome = 'completed';
        }
        catch (error) {
            failure = { error };
            admissionRefused = safeCode(error) === 'ADMISSION_REFUSED';
            usage ??= errorUsage(error);
            if (!nativeCompleted && safeCode(error) === 'TIMEOUT')
                outcome = 'timeout';
            else if (!nativeCompleted && ['ABORTED', 'CANCELLED'].includes(safeCode(error) ?? ''))
                outcome = 'aborted';
            if (scope.signal.aborted || scope.remainingMs() < 1)
                outcome = safeCode(scope.signal.reason) === 'TIMEOUT' || scope.remainingMs() < 1 ? 'timeout' : 'aborted';
            quality = { state: 'unknown', reason: outcome.toUpperCase().replaceAll('-', '_') };
            if (dispatchedAt !== undefined && durationMs === undefined)
                durationMs = Math.max(0, performance.now() - dispatchedAt);
        }
        finally {
            try {
                await agent.close();
            }
            catch (error) {
                failure = combineFailure(failure, error);
                quality = { state: 'unknown', reason: 'CLEANUP_FAILED' };
                if (outcome === 'completed')
                    outcome = 'failed';
            }
        }
        if (scope.signal.aborted || scope.remainingMs() < 1) {
            failure ??= { error: scope.signal.reason ?? new Error('Learning operation deadline exceeded') };
            outcome = safeCode(scope.signal.reason) === 'TIMEOUT' || scope.remainingMs() < 1 ? 'timeout' : 'aborted';
            quality = { state: 'unknown', reason: outcome.toUpperCase() };
        }
        // Release may itself report UNKNOWN infrastructure. Settle it exactly once
        // before any terminal observation or trainable shadow is published.
        await scope.drain();
        await settleReservation();
        const infrastructureHalted = failure !== undefined && isExecutionHalted(failure.error);
        if (infrastructureHalted) {
            outcome = 'failed';
            quality = { state: 'unknown', reason: 'EXECUTION_HALTED' };
        }
        if (!infrastructureHalted && admissionRefused) {
            outcome = 'failed';
            quality = { state: 'unknown', reason: 'ADMISSION_REFUSED' };
        }
        // Actual iterator, verification, cleanup and logical reservation have settled.
        observation = sealLearningRecord('observation', { format: 1, id: plan.observationId, domain: state.domain, attemptId: attempt.id,
            decisionId: receipt.id, decisionDigest: receipt.digest, action, taskDigest: c.taskDigest, features: c.features,
            split: captured.split, ...splitMetadata, outcome, quality,
            latency: infrastructureHalted || admissionRefused || dispatchedAt === undefined ? { state: 'unknown' } : { state: !nativeCompleted && (outcome === 'timeout' || outcome === 'aborted') ? 'right-censored' : 'observed', durationMs: durationMs ?? Math.max(0, performance.now() - dispatchedAt) },
            ...(usage === undefined ? {} : { usage }), ...(observedModels === undefined ? {} : { observedModels }), ...(identityAfter === undefined ? {} : { identityAfter }), createdAt: Date.now() });
        try {
            await state.store.appendObservation(observation);
        }
        catch (error) {
            failure = combineFailure(failure, error);
        }
        if (failure === undefined) {
            try {
                shadow = await saveShadow(state, c, preflight!, scope);
            }
            catch (error) {
                failure = { error };
            }
        }
    }
    catch (error) {
        failure = combineFailure(failure, error);
    }
    finally {
        await scope.drain();
        await settleReservation();
    }
    let maintenance: LearningRunResult['maintenance'] = { status: 'not-requested' };
    try {
        if (failure !== undefined)
            throw failure.error;
        assertActive(scope);
        if (captured.maintenance && c.evaluationArmId === undefined && captured.split === 'train') {
            // Production has settled, persisted and released its reservation. Its deadline ends here.
            scope.dispose();
            maintenance = await runMaintenance(captured);
            assertCallerActive(c.signal);
        }
        else {
            assertActive(scope);
        }
        return { turn: turn!, receipt: receipt!, observation: observation!, shadow: shadow!, maintenance };
    }
    catch (error) {
        if (dispatchedAt !== undefined && error instanceof LearningSelectionError)
            throw new Error('Learning turn failed after dispatch', { cause: error });
        throw error;
    }
    finally {
        scope.dispose();
    }
}
