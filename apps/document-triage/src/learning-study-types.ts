import type { Runtime, Turn } from 'hiveagents-runtime';
import type { ObservedTaskBudget } from 'hiveagents-runtime/orchestration';
import type { LearningAction, LearningDecision, LearningDefinition, LearningEpisode, LearningGate, LearningGateCommit, LearningObservation, LearningPointer, LearningPolicyConfig, LearningPreflight, LearningStore } from 'hiveagents-runtime/routing/learning';
import type { CurriculumIdentity, CurriculumTaskIdentity, LearningCurriculum } from './learning-curriculum.js';
export interface StudyEnvironment {
  directory: string; domain: string; protocolDigest: string; definition: LearningDefinition; timeoutMs: number;
  runtime: Runtime; router: import('hiveagents-runtime/routing/learning').LearningRouter;
  evidence: LearningStore; corpus: LearningCurriculum; budget: ObservedTaskBudget;
}
export interface StudyCell {
  taskId: string; taskDigest: string; actionKey: string; armId: string; split: 'train'|'fixed'|'fresh';
  attemptId: string; observationId: string; episodeId?: string; repetition?: number;
}
export interface StudyCycle {
  id: string; batchId: string; batchDigest: string; gateId: string; operation: 'promote'|'rollback';
  before: LearningPointer; challenger?: string|null; cells: StudyCell[];
  fixed?: LearningEpisode; fresh?: LearningEpisode; completed: boolean;
  seenTrain?: string[]; seenThrough?: number;
}
export interface ProductionIntent extends CurriculumTaskIdentity {
  attemptId: string; observationId: string; terminalDigest?: string;
}
export interface StudyJournal {
  format: 1; studyId: string; domain: string; baseDigest: string; protocolDigest: string;
  definitionDigest: string; timeoutMs: number; binding: LearningPreflight; config: LearningPolicyConfig;
  limits: LearningCurriculum['study']; evaluation: LearningCurriculum['evaluation']; identity: CurriculumIdentity;
  admittedAttempts: number; calibration: StudyCell[]; cycles: StudyCycle[]; production: ProductionIntent[];
}
export interface StudyCycleReport {
  id: string; batchId: string; batchDigest: string; domain: string; from: string|null; challenger: string|null;
  gate: LearningGate; commit: LearningGateCommit; pointer: LearningPointer; pointerAtCommit: LearningPointer;
  fixedEpisodeId: string; freshEpisodeId: string;
  expectedCells: number; terminalCells: number; verifiedCells: number; observationDigests: string[];
  comparison: { incumbentPassRate: number|null; learnedPassRate: number|null; bestFixedPassRate: number|null; candidateCoverage: number };
  dataSources: { baseDigest: string; batchDigest: string; definitionDigest: string; protocolDigest: string; actions: readonly LearningAction[];
    fixedEpisodeId: string; fixedEpisodeDigest: string; freshEpisodeId: string; freshEpisodeDigest: string };
}
export interface StudyStatus {
  status: 'completed'|'paused'|'exhausted'|'deferred'|'blocked'; domain: string; studyId: string; baseDigest: string;
  registeredBatches: readonly { id: string; digest: string }[]; invocationAttempts: number; admittedAttempts: number; maxLaunches: number;
  cycles: StudyCycleReport[]; pointer: LearningPointer; activeBatchId?: string; pendingAttemptIds?: string[]; reason?: string;
  owner?: { runId: string; token: string; pid: number; host: string };
}
export type StudyRunResult = StudyStatus;
export interface StudyTaskResult {
  status: 'completed'|'replayed'|'blocked'; turn?: Turn; receipt?: LearningDecision; observation?: LearningObservation;
  maintenance?: StudyRunResult|{ status: 'deferred'|'failed'; reason: string };
  domain: string; studyId: string; pointer: LearningPointer; invocationAttempts: number; admittedAttempts: number; pendingAttemptIds?: string[];
}
export interface StudyRunOptions {
  maxLaunches: number; cycles?: number; operation?: 'promote'|'rollback'; batchId?: string; mode?: 'explicit'|'maintenance'; signal?: AbortSignal;
}
