import type { Usage } from '../../src/public/types.js';
import type {
  DynamicAgentRequest, DynamicAgentRunner, DynamicWorkflowEvent, DynamicWorkflowMeta, JsonValue,
} from '../../src/orchestration/dynamic/types.js';

export type Reply = { text: string; output?: JsonValue; usage?: Usage };
export type Handler = (request: DynamicAgentRequest) => Reply | Promise<Reply>;

export const meta: DynamicWorkflowMeta = { name: 'test', description: 'A test workflow' };

export const usage = (input: number, output: number, extra: Partial<Usage> = {}): Usage =>
  ({ inputTokens: input, outputTokens: output, costMeaning: 'unavailable', ...extra });

/** A fake runner that records requests and the peak number of concurrent runs. */
export function fakeRunner(handler: Handler = request => ({ text: `done:${request.prompt}` })) {
  const calls: DynamicAgentRequest[] = [];
  let active = 0, peak = 0;
  const runner: DynamicAgentRunner = {
    async run(request) {
      calls.push(request);
      active++; peak = Math.max(peak, active);
      try { return await handler(request); } finally { active--; }
    },
  };
  return { runner, calls, get peak() { return peak; }, get prompts() { return calls.map(call => call.prompt); } };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Rejects once the request's signal aborts (a well-behaved runner). */
export function untilAborted(request: DynamicAgentRequest): Promise<never> {
  return new Promise((_, reject) => {
    if (request.signal.aborted) { reject(new Error('aborted')); return; }
    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

export function recorder() {
  const events: DynamicWorkflowEvent[] = [];
  return { events, onEvent: (event: DynamicWorkflowEvent) => { events.push(event); }, types: () => events.map(event => event.type) };
}
