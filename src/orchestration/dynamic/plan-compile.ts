import { isDynamicUsageError } from './limits.js';
import { DynamicPlanError } from './plan-error.js';
import { checkPlanArgs, itemCount, planLimits, planWaves, validatePlan } from './plan.js';
import { parseReference, renderTemplate, resolvePath, type TemplateScope } from './template.js';
import type {
  CompilePlan, DynamicAgentOptions, DynamicLimits, DynamicPlanStep, DynamicWorkflowContext, DynamicWorkflowPlan,
  DynamicWorkflowScript, JsonValue,
} from './types.js';

/**
 * Compiles a plan to the script the engine runs.
 *
 * The script runs the steps in dependency waves. All agent calls of one wave (an `agent` step is one
 * call, a `map` step one call per item) go through `ctx.parallel` together, so independent steps run
 * concurrently and `parallel` is never nested. Before a wave starts, every prompt of the wave is
 * rendered and every `map` resolves its `over` to an array: a non-array, more items than allowed, a
 * missing value or an oversized prompt throws `DynamicPlanError` before any call of that wave runs.
 * Every `args` reference is checked once, before the first call of the run.
 *
 * Labels are the step id for an `agent` step and `${id}[${index}]` for each item of a `map` step. A
 * failed agent leaves `null` in its slot. An engine usage error (a call the run refuses outright, such as
 * `isolation: 'worktree'` without `DynamicRunOptions.isolation`) is never turned into `null`: the script
 * rethrows it once the wave settles, so the run fails visibly. The script returns the `result` step's output (default: the
 * last step's). Same plan, same args and same earlier outputs: the same calls, in the same order, with
 * the same labels, which is what the engine's journal replays on resume.
 */

interface Call {
  readonly prompt: string;
  readonly options: DynamicAgentOptions;
}

const OPTION_KEYS = ['phase', 'schema', 'model', 'effort', 'permissions', 'isolation', 'timeoutMs'] as const;

function optionsOf(step: DynamicPlanStep, label: string): DynamicAgentOptions {
  const options: Record<string, unknown> = { label };
  for (const key of OPTION_KEYS) if (step[key] !== undefined) options[key] = step[key];
  return options as DynamicAgentOptions;
}

function located<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof DynamicPlanError && error.path === '$') throw DynamicPlanError.of(error.code, path, error.message.replace(/^\$: /, ''));
    throw error;
  }
}

async function runCalls(context: DynamicWorkflowContext, calls: readonly Call[], chunk: number): Promise<JsonValue[]> {
  const results: JsonValue[] = [];
  // `parallel` takes at most `maxItems` thunks per call; a wider wave runs in consecutive slices.
  for (let at = 0; at < calls.length; at += chunk) {
    const slice = calls.slice(at, at + chunk);
    let refused: unknown;
    // `parallel` turns a rejection into null; `agent` rejects only for usage errors, which must fail the run.
    // The call itself still starts synchronously inside the thunk, so keys follow the slice order.
    const settled = await context.parallel(slice.map(call => async () => {
      try { return await context.agent(call.prompt, call.options); }
      catch (error) { if (isDynamicUsageError(error)) refused ??= error; throw error; }
    }));
    if (refused !== undefined) throw refused;
    for (const value of settled) results.push(value ?? null);
  }
  return results;
}

export const compilePlan: CompilePlan = (input, limits) => compileValidatedPlan(validatePlan(input, limits), limits);

/** Compiles a plan `validatePlan` already accepted under the same `limits`. */
export function compileValidatedPlan(plan: DynamicWorkflowPlan, limits: DynamicLimits | undefined): ReturnType<CompilePlan> {
  const resolved = planLimits(limits);
  const waves = planWaves(plan);
  const indexOf = new Map(plan.steps.map((step, index) => [step.id, index]));
  const resultId = plan.result ?? plan.steps[plan.steps.length - 1]!.id;
  const ceiling = (step: DynamicPlanStep) => (step.kind === 'map' ? step.maxItems ?? resolved.maxItems : 1);

  const script: DynamicWorkflowScript = async (context) => {
    checkPlanArgs(plan, context.args, limits);
    const outputs: Record<string, JsonValue> = Object.create(null);
    let current: string | undefined;
    for (const wave of waves) {
      context.signal.throwIfAborted();
      const calls: Call[] = [];
      const slots: Array<{ step: DynamicPlanStep; count: number }> = [];
      for (const step of wave) {
        const path = `$.steps[${indexOf.get(step.id)}]`;
        const scope: TemplateScope = { args: context.args, steps: outputs };
        if (step.kind === 'agent') {
          calls.push({ prompt: located(`${path}.prompt`, () => renderTemplate(step.prompt, scope)), options: optionsOf(step, step.id) });
          slots.push({ step, count: 1 });
          continue;
        }
        const over = parseReference(step.over);
        const source = over.kind === 'args' ? context.args : over.kind === 'steps' ? outputs[over.step] : undefined;
        const items = resolvePath(source, over.path);
        const count = itemCount(items, ceiling(step), `${path}.over`, over.source);
        (items as JsonValue[]).forEach((item, index) => {
          calls.push({
            prompt: located(`${path}.prompt`, () => renderTemplate(step.prompt, { ...scope, item, index })),
            options: optionsOf(step, `${step.id}[${index}]`),
          });
        });
        slots.push({ step, count });
      }
      for (const step of wave) {
        if (step.phase !== undefined && step.phase !== current) {
          current = step.phase;
          context.phase(current);
        }
      }
      const results = calls.length > 0 ? await runCalls(context, calls, resolved.maxItems) : [];
      let at = 0;
      for (const { step, count } of slots) {
        outputs[step.id] = step.kind === 'agent' ? results[at] ?? null : results.slice(at, at + count);
        at += count;
      }
    }
    context.signal.throwIfAborted();
    return outputs[resultId] ?? null;
  };

  return { meta: plan.meta, script };
}
