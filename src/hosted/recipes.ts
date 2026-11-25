import { relative } from 'node:path';
import { buildEnvironment } from '../core/environment.js';
import type { AgentOptions, EnvironmentPolicy } from '../public/types.js';
import type { ExecProbeTurn, ExecTurnRequest } from '../adapters/provider.js';
import type { HostedProviderDescriptor, HostedRecipeDescriptor } from './types.js';
import { hostedDigest, invalid, snapshot } from './json.js';
export function createRecipeMatcher(d: HostedProviderDescriptor) {
    const base = { ...process.env }, environments = new Map<string, Set<string>>();
    const remember = (policy: EnvironmentPolicy) => {
        const digest = hostedDigest(policy), ids = d.recipes.filter(r => r.clientEnvironmentPolicyDigest === digest).map(r => r.recipeId);
        if (!ids.length)
            invalid();
        const envDigest = hostedDigest(buildEnvironment(policy, base));
        environments.set(envDigest, new Set(ids));
    };
    for (const mode of ['inherit', 'minimal', 'explicit'] as const)
        if (d.recipes.some(r => r.clientEnvironmentPolicyDigest === hostedDigest({ mode })))
            remember({ mode });
    const cwdAllowed = (r: HostedRecipeDescriptor, cwd: string) => r.cwdRoots.some(root => { const rel = relative(root, cwd); return rel === '' || (!rel.startsWith('../') && rel !== '..' && !rel.startsWith('/')); });
    const select = (env: NodeJS.ProcessEnv, turn?: ExecProbeTurn, full?: ExecTurnRequest) => {
        const envIds = environments.get(hostedDigest(env));
        if (!envIds)
            invalid();
        const found = d.recipes.filter(r => envIds.has(r.recipeId) && (!turn || (cwdAllowed(r, turn.cwd) && hostedDigest(turn.contextArgs) === hostedDigest(r.contextArgs) && hostedDigest(turn.providerOptions ?? {}) === r.providerOptionsDigest))
            && (!full || (hostedDigest(full.permissionArgs) === hostedDigest(r.permissionArgs) && r.modelIds.includes(full.modelId) && (!full.effort || r.efforts.includes(full.effort)) && (!full.instructions || r.allowInstructions))));
        if (!found.length || new Set(found.map(r => r.environmentPolicyId)).size !== 1)
            invalid();
        return found[0]!;
    };
    return { validate(options: Readonly<AgentOptions>) { remember(snapshot(options.environment ?? { mode: options.context?.profile === undefined || options.context.profile === 'native' ? 'inherit' : 'minimal' }) as unknown as EnvironmentPolicy); },
        probe: (env: NodeJS.ProcessEnv, turn?: ExecProbeTurn) => select(env, turn), turn: (turn: ExecTurnRequest) => select(turn.env, turn, turn) };
}
