/**
 * Workflow generators for the twin: random scripts (agent / parallel / pipeline / phase, including
 * identical prompts that share a key ordinal) described as JSON specs, random plans (agent + map steps
 * over args and over earlier outputs), and a deterministic fake `DynamicAgentRunner` whose outputs,
 * failures and token usage are pure functions of (seed, prompt) so a resumed run must reproduce an
 * uninterrupted one exactly. Latency is environment noise and the runner honours `request.signal`.
 */
import { sha, sleep, unit } from './lib-twin.mjs';

export const OBJECT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'string' } },
});
export const ARRAY_SCHEMA = Object.freeze({ type: 'array', items: { type: 'string' }, maxItems: 8 });

/** A random script spec (JSON), from a seeded `rng` (sim.mjs). */
export function scriptSpec(r, { maxN = 6 } = {}) {
  const phases = ['gather', 'work', 'review'];
  const declare = r.bernoulli(0.5);
  const ops = [];
  const count = r.int(2, 5);
  for (let i = 0; i < count; i++) {
    if (r.bernoulli(0.25)) ops.push({ op: 'phase', title: r.pick(phases) });
    const kind = r.pick(['agent', 'parallel', 'pipeline']);
    if (kind === 'agent') ops.push({ op: 'agent', schema: r.bernoulli(0.4), labelled: r.bernoulli(0.5) });
    if (kind === 'parallel') ops.push({ op: 'parallel', n: r.int(1, maxN), schema: r.bernoulli(0.3), duplicate: r.bernoulli(0.25) });
    if (kind === 'pipeline') ops.push({ op: 'pipeline', n: r.int(1, maxN), stages: r.int(1, 3), schema: r.bernoulli(0.3) });
  }
  return {
    kind: 'script',
    meta: { name: 'twin-script', description: 'Random twin script.', ...(declare ? { phases: phases.map(title => ({ title })) } : {}) },
    ops,
  };
}

/** The script a spec describes; deterministic given its agents' outputs. */
export function scriptFromSpec(spec, hooks = {}) {
  return async ctx => {
    hooks.context?.(ctx);
    const out = [];
    let previous = 'start';
    for (const [i, op] of spec.ops.entries()) {
      if (op.op === 'phase') { ctx.phase(op.title); continue; }
      const options = op.schema ? { schema: OBJECT_SCHEMA } : {};
      if (op.op === 'agent') {
        const value = await ctx.agent(`Step ${i}: summarise ${JSON.stringify(previous)}.`, { ...options, ...(op.labelled ? { label: `a${i}` } : {}) });
        out.push(value); previous = value;
      } else if (op.op === 'parallel') {
        const thunks = Array.from({ length: op.n }, (_, j) => () => {
          hooks.thunk?.(i, j);
          return ctx.agent(op.duplicate ? `Step ${i}: same question about ${JSON.stringify(previous)}.` : `Step ${i}: item ${j} of ${JSON.stringify(previous)}.`, options);
        });
        let values;
        try { values = await ctx.parallel(thunks); } catch (error) { values = { refused: error?.name ?? 'Error' }; }
        out.push(values); previous = Array.isArray(values) ? values.filter(v => v !== null).length : values;
      } else if (op.op === 'pipeline') {
        const items = Array.from({ length: op.n }, (_, j) => `item-${j}`);
        const stages = Array.from({ length: op.stages }, (_, s) => (value, item) => {
          hooks.stage?.(i, s, item);
          return ctx.agent(`Step ${i} stage ${s}: ${item} after ${JSON.stringify(value)}.`, s === op.stages - 1 ? options : {});
        });
        let values;
        try { values = await ctx.pipeline(items, ...stages); } catch (error) { values = { refused: error?.name ?? 'Error' }; }
        out.push(values); previous = Array.isArray(values) ? values.filter(v => v !== null).length : values;
      }
    }
    return out;
  };
}

/** A random plan (agent + map steps) and its args. */
export function planSpec(r, { maxItems = 6, phases = r.bernoulli(0.5) } = {}) {
  const items = Array.from({ length: r.int(1, maxItems) }, (_, j) => `file-${j}.ts`);
  const steps = [{ kind: 'agent', id: 'root', prompt: 'List the topics of {{args.topic}}.', schema: ARRAY_SCHEMA }];
  const used = ['root'];
  if (r.bernoulli(0.8)) { steps.push({ kind: 'map', id: 'expand', over: 'steps.root', prompt: 'Expand the topic {{item}} (#{{index}}).' }); used.push('expand'); }
  if (r.bernoulli(0.8)) {
    steps.push({ kind: 'map', id: 'files', over: 'args.items', prompt: 'Review {{item}}.', ...(r.bernoulli(0.5) ? { schema: OBJECT_SCHEMA } : {}) });
    used.push('files');
  }
  if (r.bernoulli(0.5)) { steps.push({ kind: 'agent', id: 'side', prompt: 'Note on {{args.topic}}.' }); used.push('side'); }
  steps.push({ kind: 'agent', id: 'final', prompt: `Combine ${used.map(id => `{{steps.${id}}}`).join(' and ')}.` });
  if (phases) {
    steps.forEach(step => { step.phase = step.id === 'final' ? 'review' : 'work'; });
  }
  return {
    kind: 'plan',
    plan: {
      format: 1,
      meta: { name: 'twin-plan', description: 'Random twin plan.', ...(phases ? { phases: [{ title: 'work' }, { title: 'review' }] } : {}) },
      steps,
    },
    args: { topic: `topic-${r.int(1, 1e6)}`, items },
  };
}

/**
 * A runner whose outputs, failures, schema validity and usage are functions of (seed, prompt) only.
 * A retry carries the engine's feedback in its prompt, so it draws again (deterministically).
 */
export function deterministicRunner({ seed, RunnerError, latency, failRate = 0.06, badRate = 0.15, onInvoke, onSettle }) {
  return {
    async run(request) {
      const { prompt, signal } = request;
      onInvoke?.(request);
      const usage = {
        inputTokens: 40 + Math.floor(unit(seed, 'in', prompt) * 400),
        outputTokens: 5 + Math.floor(unit(seed, 'out', prompt) * 150),
        costMeaning: 'estimate',
      };
      try {
        await sleep(latency(), signal, () => new RunnerError('ABORTED'));
        if (unit(seed, 'fail', prompt) < failRate) throw new RunnerError('PROVIDER_FAILED', { usage });
        const tag = sha(seed, 'tag', prompt).slice(0, 10);
        const schema = request.options.schema;
        if (!schema) return { text: `t:${tag}`, usage };
        const bad = unit(seed, 'bad', prompt) < badRate;
        const output = schema.type === 'array'
          ? (bad ? 'not-an-array' : Array.from({ length: 1 + Math.floor(unit(seed, 'n', prompt) * 4) }, (_, i) => `${tag}-${i}`))
          : (bad ? { v: 7 } : { v: tag });
        return { text: JSON.stringify(output), output, usage };
      } finally { onSettle?.(request); }
    },
  };
}
