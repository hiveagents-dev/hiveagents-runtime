import { describe, expect, it } from 'vitest';
import { jsonClone } from '../../src/orchestration/workflow/checkpoint.js';
import { runEvaluation, validateEvaluationReport } from '../../src/orchestration/evaluation/index.js';

describe('plain JSON arrays at workflow and evaluation boundaries', () => {
  it.each(['root', 'nested'] as const)('rejects %s array subclasses without invoking serialization hooks', shape => {
    let hooks = 0;
    class AlteringArray extends Array { toJSON() { hooks++; return ['altered']; } }
    const array = new AlteringArray(); array.push('selected');
    expect(() => jsonClone(shape === 'root' ? array : { selected: array })).toThrow(/plain|JSON/);
    expect(hooks).toBe(0);
  });
  it('rejects array prototype getters without invoking them', () => {
    let hooks = 0;
    class GetterArray extends Array { get toJSON() { hooks++; return () => []; } }
    expect(() => jsonClone(new GetterArray())).toThrow(); expect(hooks).toBe(0);
  });
  it('rejects suite input and output subclasses and accepts ordinary arrays', async () => {
    let hooks = 0, executions = 0;
    class AlteringArray extends Array { toJSON() { hooks++; return ['altered']; } }
    const options = { id: 'plain', suite: { id: 'suite', version: '1', cases: [{ id: 'one', input: ['selected'], expected: ['selected'] }] },
      profile: { id: 'local', version: '1', sourceDigest: 'a'.repeat(64) },
      execute: () => { executions++; return { output: ['selected'] }; }, scorers: [{ id: 'score', version: '1', score: () => ({ value: 1, passed: true }) }] };
    await expect(runEvaluation({ ...options, suite: { ...options.suite, cases: [{ id: 'one', input: { nested: new AlteringArray() }, expected: true }] } })).rejects.toThrow();
    expect(executions).toBe(0);
    const invalid = await runEvaluation({ ...options, execute: () => ({ output: { nested: new AlteringArray() } }) });
    expect(invalid.attempts[0]!.status).not.toBe('passed');
    const valid = await runEvaluation(options);
    expect(validateEvaluationReport(valid)).toEqual(valid);
    const malicious = { ...valid, attempts: Object.assign(new AlteringArray(), valid.attempts) };
    expect(() => validateEvaluationReport(malicious)).toThrow(); expect(hooks).toBe(0);
  });
});
