import { digest, freeze } from '../../shared/json.js';
import type { CapturedSelection } from './factory-context.js';
import type { LearningPolicyBinding, LearningPreflight } from './types.js';
export function policyBinding(captured: CapturedSelection, preflight: LearningPreflight): LearningPolicyBinding {
    return freeze({ definitionDigest: captured.definitionDigest, actions: preflight.actions,
        ...(preflight.fallbackId === undefined ? {} : { fallbackId: preflight.fallbackId }),
        features: { schema: captured.features.schema, dimensions: captured.features.values.length } });
}
/** Current availability may narrow an approved universe, preserving its original order. */
export function appliesTo(binding: LearningPolicyBinding | undefined, current: LearningPolicyBinding): boolean {
    if (!binding || binding.definitionDigest !== current.definitionDigest || binding.fallbackId !== current.fallbackId || digest(binding.features) !== digest(current.features))
        return false;
    let previous = -1;
    for (const action of current.actions) {
        const index = binding.actions.findIndex(a => digest(a) === digest(action));
        if (index <= previous)
            return false;
        previous = index;
    }
    return true;
}
