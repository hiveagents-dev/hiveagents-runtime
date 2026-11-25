// A routed definition can opt out of a Runtime memory default with `memory: false` (only false: a
// provider object is code and has no digest). The config digest records whether the routed Agent
// has memory (provider id and scope per candidate, never a function), so evidence learned with
// and without memory is not pooled, and is unchanged for every definition without memory.
import { describe, expect, it } from 'vitest';
import { Runtime, type RuntimeOptions } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import type { AgentMemoryScope, MemoryScopeContext } from '../../src/public/memory-types.js';
import { normalize } from '../../src/routing/config.js';
import type { RoutingAgentDefinition } from '../../src/routing/types.js';
import { RecordingExec, SCOPE, recordingProvider } from '../unit/memory.fixture.js';

const provider = recordingProvider();
const withMemory = (extra: Partial<RuntimeOptions> = {}, scope: (context: MemoryScopeContext) => AgentMemoryScope = () => SCOPE) => new Runtime({ memory: { provider, scope }, ...extra });
const digestOf = (definition: object, runtime: Runtime) => normalize(definition as RoutingAgentDefinition, runtime).configDigest;

// configDigest of these definitions before memory existed; a definition without memory keeps it.
const BEFORE_MEMORY: Array<[object, string]> = [
  [{ model: 'opus-5' }, '5a751e54490afcd473d7bce323bd1627ae1804ccbb87abad86d74a512c317dcf'],
  [{ model: 'codex/gpt-5.4', instructions: 'Be brief.', cwd: '/work', effort: 'high' }, '453cbf99f63f44d7e39513c3201ed32047899b5d1fbf5647edf5703703e6120c'],
  [{ model: { mode: 'auto', candidates: ['opus-5', 'codex/gpt-5.4'] } }, 'e5fde5f05eb1959fa6870ef1ff938c10626b9283f68ce169a57f6f334ab5bc5d'],
];

describe('memory in a routed definition', () => {
  it('memory: false is accepted and opts the routed Agent out of the Runtime default', async () => {
    const exec = new RecordingExec();
    const runtime = withMemory({ adapters: [exec] });
    const { options } = normalize({ model: 'opus-5', memory: false }, runtime);
    expect(options.memory).toBe(false);
    await new Agent({ ...options, model: 'opus-5' }, runtime).send('hola');
    await new Agent({ ...normalize({ model: 'opus-5' }, runtime).options, model: 'opus-5' }, runtime).send('hola');
    expect(provider.recalls.map(({ text }) => text)).toEqual(['hola']);
    expect(exec.requests.map(({ prompt }) => prompt.startsWith('## Recalled memory'))).toEqual([false, true]);
  });

  it.each([
    ['a provider object', { provider, scope: SCOPE }],
    ['true', true],
    ['null', null],
  ])('anything but false is refused: %s', (_name, memory) => {
    expect(() => normalize({ model: 'opus-5', memory } as never, withMemory())).toThrow(TypeError);
  });
});

describe('the config digest and memory', () => {
  it.each(BEFORE_MEMORY)('is unchanged without memory: %j', (definition, before) => {
    expect(digestOf(definition, new Runtime())).toBe(before);
    expect(digestOf({ ...definition, memory: false }, new Runtime())).toBe(before);
    expect(digestOf({ ...definition, memory: false }, withMemory())).toBe(before);
  });

  it.each(BEFORE_MEMORY)('differs with memory, and is stable for the same memory: %j', (definition, before) => {
    const remembering = digestOf(definition, withMemory());
    expect(remembering).not.toBe(before);
    expect(digestOf(definition, withMemory())).toBe(remembering);
  });

  it('records the provider id and the scope each candidate gets, never a function', () => {
    const definition = { model: { mode: 'auto', candidates: ['opus-5', 'codex/gpt-5.4'] } };
    const base = digestOf(definition, withMemory());
    const other = { ...provider, id: 'other-memory' };
    expect(digestOf(definition, new Runtime({ memory: { provider: other, scope: () => SCOPE } }))).not.toBe(base);
    expect(digestOf(definition, withMemory({}, () => ({ ...SCOPE, subject: 'other' })))).not.toBe(base);
    const perModel = withMemory({}, ({ model }) => ({ ...SCOPE, subject: model.provider }));
    expect(digestOf(definition, perModel)).not.toBe(base);
    expect(digestOf({ model: 'opus-5' }, perModel)).toBe(digestOf({ model: 'opus-5' }, withMemory({}, () => ({ ...SCOPE, subject: 'claude' }))));
    expect(digestOf({ model: 'opus-5' }, withMemory({ memory: { provider, scope: () => SCOPE, onCaptureError: () => undefined } }))).toBe(digestOf({ model: 'opus-5' }, withMemory()));
  });

  it('a Runtime default the Agent would refuse is refused when the definition is normalized', () => {
    expect(() => normalize({ model: 'opus-5' }, new Runtime({ memory: { provider: { id: 'p' } as never, scope: () => SCOPE } }))).toThrow(TypeError);
    expect(() => normalize({ model: 'opus-5', memory: false }, new Runtime({ memory: { provider: { id: 'p' } as never, scope: () => SCOPE } }))).not.toThrow();
  });
});
