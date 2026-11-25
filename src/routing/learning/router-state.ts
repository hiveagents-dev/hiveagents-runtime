import { freeze, method, ownObject, snapshot } from '../../shared/json.js';
import { DEFAULT_LEARNING_POLICY } from './estimator.js';
import { learningDomainDigest, validatePolicyConfig } from './validation.js';
import type { LearningDomain, LearningPolicyConfig, LearningStore } from './types.js';
export interface RouterState {
    store: LearningStore;
    domain: string;
    protocolDigest: string;
    policy: LearningPolicyConfig;
}
export function captureRouter(options: {
    store: LearningStore;
    domain: LearningDomain;
    policy?: Partial<LearningPolicyConfig>;
}): RouterState {
    options = ownObject(options, ['store', 'domain', 'policy']);
    const domain = learningDomainDigest(options.domain);
    const protocolDigest = snapshot(options.domain).protocolDigest;
    const policy = validatePolicyConfig({ ...DEFAULT_LEARNING_POLICY, ...(options.policy === undefined ? {} : snapshot(options.policy)) });
    const store = Object.create(null) as LearningStore;
    for (const key of ['put', 'get', 'highWater', 'observations', 'appendObservation', 'pointer', 'commitGate', 'pending', 'close'] as const) {
        Object.defineProperty(store, key, { value: method(options.store, key), enumerable: true });
    }
    return freeze({ store, domain, protocolDigest, policy });
}
export function scopedPointer(value: unknown) {
    const p = snapshot(value);
    ownObject(p, ['generation', 'active', 'previous']);
    const pointer = p as {
        generation: number;
        active: string | null;
        previous: string | null;
    };
    if (!Number.isSafeInteger(pointer.generation) || pointer.generation < 0 || ![pointer.active, pointer.previous].every(x => x === null || typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)))
        throw new TypeError('Invalid learning pointer');
    return freeze(pointer);
}
