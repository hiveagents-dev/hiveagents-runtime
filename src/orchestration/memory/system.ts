/**
 * The Node-bound half of the memory module: the SQLite store and the measurement
 * harness. `./index.ts` stays free of Node imports so a renderer can bundle the
 * ranker and the gate rule; this file is exported from the orchestration entry.
 */
export { SqliteSystemMemory } from './sqlite-memory.js';
export { MAX_LESSONS_PER_RECALL, MemoryStoreError, isMemoryStoreError } from './store-types.js';
export { measureMemory } from './measurement.js';
export { hostMemoryPath, readMemoryView } from './view.js';
export type { MemoryGrantLine, MemorySystemView, MemoryView } from './view.js';
export {
  CURATOR_DEFAULT_MAX_CANDIDATES, CURATOR_DEFAULT_MAX_TEXT, CURATOR_MAX_CANDIDATES_CEILING, CURATOR_MAX_TEXT_CEILING,
  CURATOR_SOURCE, candidateId, curateMemory, fileCuratorJournal, memoryCuratorJournal, signTestPValue,
} from './curator.js';
export type {
  CuratableStore, CurateMemoryOptions, CuratorAcceptance, CuratorCandidateOutcome, CuratorDistill, CuratorDistillContext,
  CuratorEpisode, CuratorHoldReason, CuratorInvalidReason, CuratorJournal, CuratorJournalEntry, CuratorJournalOptions,
  CuratorMeasurement, CuratorPendingTally, CuratorPooledEvidence, CuratorProposal, CuratorRefusal, CuratorReport, CuratorScreen,
  CuratorScreenCandidate, CuratorScreenReason, CuratorScreenVerdict,
} from './curator.js';
export { DISTILLER_INSTRUCTIONS, agentDistiller, distillerPrompt, parseLessons } from './curator-distiller.js';
export type { AgentDistillerOptions, DistillerAgentOptions } from './curator-distiller.js';
export { ablationVerdict, runMemoryAblation } from './ablation.js';
export type {
  AblationAgent, AblationCondition, AblationConditionSummary, AblationMemoryNote, AblationOutcome, AblationRule, AblationRun,
  AblationRunContext, AblationRunError, AblationSignTest, AblationSignTests, AblationTask, AblationUsage, AblationVerdict,
  AblationVerdictReason, AblationVerdictResult, MemoryAblationOptions, MemoryAblationReport,
} from './ablation.js';
