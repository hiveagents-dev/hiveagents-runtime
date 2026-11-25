/** Optional Node-only continual learning. Native execution remains in ordinary provider Agents. */
export { LearningRouter, LearningSelectionError } from './router.js';
export { SqliteLearningStore } from './store.js';
export { hashTaskFeatures, inputDigest } from './features.js';
export { DEFAULT_LEARNING_POLICY, buildSnapshot, predict, selectPolicy } from './estimator.js';
export { sealLearningRecord, validateLearningRecord, validateFeatures, validatePolicyConfig, learningDomainDigest } from './validation.js';
export { assessGateEvidence } from './evidence.js';
export { digest as learningDigest } from '../../shared/json.js';
export type * from './types.js';
