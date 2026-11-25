import type { AgentOptions, Turn, Usage } from '../../public/types.js';
import type { Runtime } from '../../core/runtime.js';
import type { ObservedTaskBudget } from '../../orchestration/tasks/index.js';
import type { RoutingCandidateCode } from '../types.js';
export type PolicyRef = string | null;
export type LearningSplit = 'train' | 'fixed' | 'fresh';
export interface LearningFeatures {
    schema: string;
    values: readonly number[];
}
export interface LearningTask {
    id: string;
    version: string;
    inputDigest: string;
    text: string;
    features?: LearningFeatures;
}
export type LearningEvidenceScope = 'model' | 'requested-system';
/** Named options declared by the application and restricted to one provider. */
export type LearningProfile = Pick<AgentOptions, 'context' | 'permissions'> & {
    provider: string;
    providerOptions?: Pick<NonNullable<AgentOptions['providerOptions']>, 'claude' | 'codex' | 'external'>;
};
export interface LearningArm {
    profile?: string;
    evidenceScope?: LearningEvidenceScope;
    id: string;
    model: string;
    effort?: string;
}
export interface LearningDomain {
    id: string;
    sourceDigest: string;
    scorerDigest: string;
    protocolDigest: string;
}
export interface LearningAction {
    evidenceScope: LearningEvidenceScope;
    id: string;
    model: string;
    provider: string;
    modelId: string;
    optionsDigest: string;
    executionDigest: string;
    key: string;
}
export type LearningQuality = {
    state: 'verified';
    value: number;
    passed: boolean;
} | {
    state: 'unknown';
    reason: string;
};
export type LearningLatency = {
    state: 'observed' | 'right-censored';
    durationMs: number;
} | {
    state: 'unknown';
};
export interface LearningObservation {
    format: 1;
    id: string;
    domain: string;
    attemptId: string;
    decisionId: string;
    decisionDigest: string;
    action: LearningAction;
    taskDigest: string;
    features: LearningFeatures;
    split: LearningSplit;
    episodeId?: string;
    repetition?: number;
    outcome: 'completed' | 'refused' | 'failed' | 'aborted' | 'timeout' | 'verifier-error' | 'identity-drift';
    quality: LearningQuality;
    latency: LearningLatency;
    usage?: Usage;
    observedModels?: readonly string[];
    identityAfter?: string;
    createdAt: number;
    digest: string;
}
export interface SequencedObservation {
    sequence: number;
    observation: LearningObservation;
}
export interface LearningPolicyConfig {
    objective: 'quality' | 'latency' | 'cost';
    minDistinctTasks: number;
    minSimilarity: number;
    maxAgeMs: number;
    halfLifeMs: number;
    qualityFloor: number;
    maxRows: number;
    alpha: number;
    minImprovement: number;
    minFreshTasks: number;
}
export interface LearningPolicyBinding {
    definitionDigest: string;
    actions: readonly LearningAction[];
    fallbackId?: string;
    features: {
        schema: string;
        dimensions: number;
    };
}
export interface LearningSnapshot {
    binding?: LearningPolicyBinding;
    format: 1;
    domain: string;
    config: LearningPolicyConfig;
    through: number;
    rows: readonly SequencedObservation[];
    createdAt: number;
    digest: string;
}
export interface LearningPrediction {
    actionKey: string;
    support: number;
    effectiveSupport: number;
    meanQuality?: number;
    lowerQuality?: number;
    upperQuality?: number;
    latencyMs?: number;
    costUsd?: number;
    costMeaning?: string;
    reason: 'supported' | 'cold-start' | 'out-of-distribution' | 'stale' | 'unknown-metric';
}
export interface LearningPointer {
    generation: number;
    active: PolicyRef;
    previous: PolicyRef;
}
export interface LearningCandidate {
    id: string;
    model: string;
    provider: string;
    modelId: string;
    status: 'eligible' | 'excluded' | 'not-evaluated';
    code: RoutingCandidateCode;
    action?: LearningAction;
}
export interface LearningDecision {
    format: 1;
    id: string;
    domain: string;
    createdAt: number;
    taskDigest: string;
    featuresDigest: string;
    definitionDigest: string;
    policy: PolicyRef;
    mode: 'fixed' | 'auto' | 'matrix';
    reason: 'FIXED' | 'INCUMBENT' | 'LEARNED' | 'MATRIX' | 'FALLBACK' | 'NO_ROUTE' | 'ABORTED' | 'TIMEOUT';
    candidates: readonly LearningCandidate[];
    predictions: readonly LearningPrediction[];
    selected?: LearningAction;
    nativeDispatches: 0;
    digest: string;
}
export interface LearningAttempt {
    observationId: string;
    format: 1;
    id: string;
    domain: string;
    decisionId: string;
    decisionDigest: string;
    action: LearningAction;
    taskDigest: string;
    features: LearningFeatures;
    split: LearningSplit;
    episodeId?: string;
    repetition?: number;
    startedAt: number;
    digest: string;
}
export interface LearningEpisode {
    format: 1;
    id: string;
    domain: string;
    kind: 'fixed' | 'fresh';
    createdAt: number;
    definitionDigest: string;
    protocolDigest: string;
    afterSequence: number;
    arms: readonly LearningAction[];
    fallbackId?: string;
    tasks: readonly {
        taskDigest: string;
        features: LearningFeatures;
    }[];
    repetitions: number;
    cells: readonly {
        taskDigest: string;
        actionKey: string;
        repetition: number;
        attemptId: string;
        observationId: string;
    }[];
    comparison?: {
        expectedGeneration: number;
        from: PolicyRef;
        to: PolicyRef;
        operation: 'promote' | 'rollback';
        fixedEpisodeId: string;
        config: LearningPolicyConfig;
        configDigest: string;
    };
    digest: string;
}
export interface LearningPairedTask {
    taskDigest: string;
    fromAction: string;
    toAction: string;
    qualityDelta?: number;
    passRateDelta?: number;
    objectiveGain?: number;
}
export interface LearningAssessment {
    episodeId: string;
    episodeDigest: string;
    observationDigests: readonly string[];
    expectedCells: number;
    verifiedCells: number;
    tasks: readonly LearningPairedTask[];
    wins: number;
    losses: number;
    ties: number;
    pValue?: number;
    meanGain?: number;
}
export interface LearningGate {
    format: 1;
    id: string;
    domain: string;
    createdAt: number;
    mode: 'promote' | 'rollback';
    expectedGeneration: number;
    from: PolicyRef;
    to: PolicyRef;
    definitionDigest: string;
    configDigest: string;
    outcome: 'keep' | 'promote' | 'rollback';
    reason: 'SUPPORTED' | 'INCOMPLETE' | 'REGRESSION' | 'INSUFFICIENT' | 'INCOMPARABLE';
    fixed: LearningAssessment;
    fresh: LearningAssessment;
    digest: string;
}
export interface LearningGateCommit {
    format: 1;
    id: string;
    domain: string;
    gateDigest: string;
    status: 'kept' | 'promoted' | 'rolled-back' | 'stale';
    before: LearningPointer;
    after: LearningPointer;
    createdAt: number;
    digest: string;
}
export interface EvidenceMap {
    decision: LearningDecision;
    attempt: LearningAttempt;
    snapshot: LearningSnapshot;
    episode: LearningEpisode;
    observation: LearningObservation;
    gate: LearningGate;
    'gate-commit': LearningGateCommit;
}
export type PutKind = 'decision' | 'attempt' | 'snapshot' | 'episode';
export interface LearningStore {
    put<K extends PutKind>(kind: K, id: string, row: EvidenceMap[K]): Promise<void>;
    get<K extends keyof EvidenceMap>(kind: K, id: string): Promise<EvidenceMap[K] | undefined>;
    highWater(domain: string): Promise<number>;
    observations(domain: string, options?: {
        through?: number;
        split?: LearningSplit;
        limit?: number;
        verifiedOnly?: boolean;
        schema?: string;
        dimensions?: number;
        actionKeys?: readonly string[];
        observationIds?: readonly string[];
    }): Promise<readonly SequencedObservation[]>;
    appendObservation(value: LearningObservation): Promise<SequencedObservation>;
    pointer(domain: string): Promise<LearningPointer>;
    commitGate(value: LearningGate): Promise<LearningGateCommit>;
    pending(domain: string): Promise<readonly LearningAttempt[]>;
    close(): void;
}
export type LearningDefinition = Omit<AgentOptions, 'model'> & {
    /** Profiles choose provider-specific policy without replacing declared shared policy. */
    profiles?: Readonly<Record<string, LearningProfile>>;
    /** Native structured output required on every run of this definition. */
    outputSchema?: Record<string, unknown>;
    model: string | {
        mode: 'auto';
        candidates: readonly LearningArm[];
        fallback?: string;
        providers?: readonly string[];
        allowUnverifiedModels?: boolean;
        allowUnknownAuth?: boolean;
    };
};
export interface LearningContext {
    runtime: Runtime;
    task: LearningTask;
    id?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    evaluationArmId?: string;
}
export interface LearningRunContext extends LearningContext {
    /** Optional exact execution universe; checked after admission/preparation, before durable start. */
    expectedBinding?: LearningPolicyBinding;
    input: string;
    verify: (turn: Turn) => Promise<{
        value: number;
        passed: boolean;
    }> | {
        value: number;
        passed: boolean;
    };
    split?: LearningSplit;
    episodeId?: string;
    repetition?: number;
    attemptId?: string;
    observationId?: string;
    budget: ObservedTaskBudget;
    maintenanceTimeoutMs?: number;
    maintenance?: (context: { signal: AbortSignal }) => Promise<void>;
}
export interface LearningRunResult {
    turn: Turn;
    receipt: LearningDecision;
    observation: LearningObservation;
    shadow: LearningSnapshot;
    maintenance: {
        status: 'not-requested' | 'completed' | 'failed';
        code?: string;
    };
}
export interface LearningGateOptions {
    id: string;
    freshEpisodeId: string;
}
export interface LearningPreflight {
    domain: string;
    definitionDigest: string;
    actions: readonly LearningAction[];
    candidates: readonly LearningCandidate[];
    fallbackId?: string;
}
