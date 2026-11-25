import type { LearningContext, LearningDefinition, LearningDomain, LearningGateOptions, LearningPolicyConfig, LearningRunContext, LearningStore } from './types.js';
import { assertActive, captureSelection, createScope } from './factory-context.js';
import { decide } from './factory-decision.js';
import { prepareSelection } from './factory.js';
import { improvePolicy } from './gate.js';
import { captureRouter, scopedPointer, type RouterState } from './router-state.js';
import { captureRun } from './run-context.js';
import { executeRun } from './run.js';
import { saveShadow } from './snapshot.js';
/** Optional local evidence router. Its ledger never grants execution authority. */
export class LearningRouter {
    readonly #state: RouterState;
    constructor(options: {
        store: LearningStore;
        domain: LearningDomain;
        policy?: Partial<LearningPolicyConfig>;
    }) { this.#state = captureRouter(options); }
    async preflight(definition: LearningDefinition, context: LearningContext) {
        const started = performance.now(), captured = captureSelection(definition, context), scope = createScope(captured, started);
        try {
            const prepared = await prepareSelection(captured, this.#state.domain, scope);
            await scope.drain();
            assertActive(scope);
            scope.dispose();
            return prepared.preflight;
        }
        catch (error) {
            await scope.drain();
            scope.dispose();
            throw error;
        }
    }
    async createAgent(definition: LearningDefinition, context: LearningContext) {
        const started = performance.now(), captured = captureSelection(definition, context), scope = createScope(captured, started);
        try {
            const { agent, receipt } = await decide(this.#state, captured, scope);
            await scope.drain();
            assertActive(scope);
            scope.dispose();
            return { agent, receipt };
        }
        catch (error) {
            await scope.drain();
            scope.dispose();
            throw error;
        }
    }
    async run(definition: LearningDefinition, context: LearningRunContext) {
        const started = performance.now(), captured = captureRun(definition, context);
        return executeRun(this.#state, captured, started);
    }
    async shadow(definition: LearningDefinition, context: LearningContext) {
        const started = performance.now(), captured = captureSelection(definition, context), scope = createScope(captured, started);
        try {
            const prepared = await prepareSelection(captured, this.#state.domain, scope);
            const value = await saveShadow(this.#state, captured, prepared.preflight, scope);
            await scope.drain();
            assertActive(scope);
            scope.dispose();
            return value;
        }
        catch (error) {
            await scope.drain();
            scope.dispose();
            throw error;
        }
    }
    async improve(options: LearningGateOptions) { return improvePolicy(this.#state, options); }
    async inspect() { return scopedPointer(await this.#state.store.pointer(this.#state.domain)); }
}
export { LearningSelectionError } from './factory-decision.js';
