import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PostconditionRegistry, runPromotionGate } from '../../src/orchestration/evaluation/index.js';
import type { PostconditionVerifier, PromotionGateOptions, PromotionSubject } from '../../src/orchestration/evaluation/index.js';
import type { JsonValue } from '../../src/orchestration/workflow/types.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const HARNESS = sha('harness v1');
const PROMPT_SAVE = 'Schedule the follow-up and save it in the followups table.';
const PROMPT_TALK = 'Tell the customer that you will follow up.';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

/**
 * A stand-in for an agent turn, driven only by its prompt. No model is called. It always ends by
 * saying it is done; whether it wrote the row depends on what the prompt told it to do.
 */
function fakeAgent(prompt: string, database: string, customer: string): string {
  if (prompt.includes('save it')) {
    const db = new DatabaseSync(database);
    db.prepare('INSERT INTO followups(customer, status) VALUES (?, ?)').run(customer, 'scheduled');
    db.close();
  }
  return `Done: the follow-up for ${customer} is scheduled.`;
}

/** One system under a given prompt. Every attempt works on its own real SQLite file. */
function subject(prompt: string, overrides: Partial<PromotionSubject['profile']> = {}) {
  const runs: string[] = [];
  const value: PromotionSubject = {
    profile: { id: 'followups', version: '1', sourceDigest: HARNESS, provider: 'claude', model: 'model-a', ...overrides },
    promptDigest: sha(prompt),
    run(input) {
      const directory = mkdtempSync(join(tmpdir(), 'oar-gate-'));
      dirs.push(directory);
      const database = join(directory, 'system.sqlite');
      const db = new DatabaseSync(database);
      db.exec('CREATE TABLE followups(customer TEXT NOT NULL, status TEXT NOT NULL) STRICT');
      db.close();
      const customer = (input as { customer: string }).customer;
      runs.push(customer);
      return { state: { database }, claim: fakeAgent(prompt, database, customer) };
    },
  };
  return { value, runs };
}

/** Reads the state the run left behind. It never sees what the agent said. */
const followupRecorded: PostconditionVerifier = {
  id: 'followup recorded',
  version: '1',
  verify({ state, input }) {
    const db = new DatabaseSync((state as { database: string }).database, { readOnly: true });
    try {
      const customer = (input as { customer: string }).customer;
      const rows = db.prepare('SELECT status FROM followups WHERE customer = ?').all(customer);
      const evidence = { table: 'followups', customer, rows: rows.length, statuses: rows.map(row => String(row.status)) };
      return rows.length === 1 && rows[0]!.status === 'scheduled' ? { status: 'verified', evidence } : { status: 'failed', evidence, code: 'ROW_MISSING' };
    } finally {
      db.close();
    }
  },
};

const declared = [{ id: 'followup recorded', description: 'Each request leaves one scheduled follow-up row.' }];
const suite = { id: 'followups', version: '1', cases: [{ id: 'ana', input: { customer: 'ana' }, expected: null }, { id: 'luis', input: { customer: 'luis' }, expected: null }] };

function options(baseline: PromotionGateOptions['baseline'], candidate: PromotionSubject, extra: Partial<PromotionGateOptions> = {}): PromotionGateOptions {
  return { id: 'followups-gate', postconditions: declared, verifiers: new PostconditionRegistry().register(followupRecorded), suite, baseline, candidate, timeoutMs: 10_000, ...extra };
}

describe('promotion gate by verified state', () => {
  it('blocks a prompt change that breaks a postcondition, whatever the agent says', async () => {
    const baseline = subject(PROMPT_SAVE), candidate = subject(PROMPT_TALK);
    const decision = await runPromotionGate(options(baseline.value, candidate.value));

    expect(decision.decision).toBe('block');
    expect(decision.changed).toEqual(['prompt']);
    expect(decision.blocks).toEqual([{ code: 'POSTCONDITION_FAILED', postconditionId: 'followup recorded', failedAttempts: 2, regression: true }]);
    expect(decision.postconditions).toMatchObject([{ id: 'followup recorded', baseline: 'verified', candidate: 'failed', verifierVersion: '1' }]);
    expect(baseline.runs).toEqual(['ana', 'luis']);
    expect(candidate.runs).toEqual(['ana', 'luis']);

    // The evidence is what the verifier found in the database, for each attempt.
    expect(decision.candidate?.attempts.map(attempt => attempt.postconditions)).toEqual([
      [{ id: 'followup recorded', status: 'failed', code: 'ROW_MISSING', evidence: { table: 'followups', customer: 'ana', rows: 0, statuses: [] } }],
      [{ id: 'followup recorded', status: 'failed', code: 'ROW_MISSING', evidence: { table: 'followups', customer: 'luis', rows: 0, statuses: [] } }],
    ]);
    expect(decision.baseline?.attempts[0]?.postconditions).toEqual([
      { id: 'followup recorded', status: 'verified', evidence: { table: 'followups', customer: 'ana', rows: 1, statuses: ['scheduled'] } },
    ]);
    // The agent claimed success in both runs. The claim is kept only as a digest.
    expect(decision.candidate?.attempts[0]?.claimDigest).toBe(sha('Done: the follow-up for ana is scheduled.'));
    expect(JSON.stringify(decision)).not.toContain('Done:');
    expect(decision.comparison?.deltas.passRate).toBe(-1);
  });

  it('promotes a change that keeps every postcondition verified, and the decision is recordable data', async () => {
    const baseline = subject(PROMPT_SAVE), candidate = subject(`${PROMPT_SAVE} Be brief.`);
    const decision = await runPromotionGate(options(baseline.value, candidate.value, { repetitions: 2 }));

    expect(decision).toMatchObject({ format: 1, id: 'followups-gate', decision: 'promote', changed: ['prompt'], blocks: [] });
    expect(decision.postconditions).toMatchObject([{ baseline: 'verified', candidate: 'verified' }]);
    expect(decision.candidate?.report.metrics).toMatchObject({ total: 4, passed: 4 });
    expect(decision.candidate?.promptDigest).toBe(sha(`${PROMPT_SAVE} Be brief.`));
    expect(decision.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(decision) && Object.isFrozen(decision.candidate?.attempts[0]?.postconditions[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it('counts a verified state as done even when the agent says it failed', async () => {
    const baseline = subject(PROMPT_SAVE), candidate = subject(`${PROMPT_SAVE} Then report.`);
    const run = candidate.value.run;
    candidate.value.run = async (input, context) => ({ ...(await run(input, context)), claim: 'I could not schedule anything.' });
    const decision = await runPromotionGate(options(baseline.value, candidate.value));
    expect(decision.decision).toBe('promote');
  });

  it('blocks without running anything when a declared postcondition has no registered verifier', async () => {
    const baseline = subject(PROMPT_SAVE), candidate = subject(PROMPT_TALK);
    const postconditions = [...declared, { id: 'customer notified', description: 'The customer received one message.' }];
    const decision = await runPromotionGate(options(baseline.value, candidate.value, { postconditions }));

    expect(decision.decision).toBe('block');
    expect(decision.blocks).toEqual([{ code: 'VERIFIER_MISSING', postconditionId: 'customer notified' }]);
    expect(decision.postconditions).toMatchObject([
      { id: 'followup recorded', candidate: 'not-verified' },
      { id: 'customer notified', candidate: 'unverifiable', verifierVersion: null },
    ]);
    expect(baseline.runs).toEqual([]);
    expect(candidate.runs).toEqual([]);
    expect(decision.candidate).toBeUndefined();
  });

  it('blocks when the system declares no postcondition at all: nothing could be verified', async () => {
    const baseline = subject(PROMPT_SAVE), candidate = subject(PROMPT_TALK);
    const decision = await runPromotionGate(options(baseline.value, candidate.value, { postconditions: [] }));
    expect(decision).toMatchObject({ decision: 'block', blocks: [{ code: 'NO_POSTCONDITIONS' }] });
    expect(candidate.runs).toEqual([]);
  });

  it('runs only when harness, model or prompt changed, and says which', async () => {
    const same = await runPromotionGate(options(subject(PROMPT_SAVE).value, subject(PROMPT_SAVE, { version: '2' }).value));
    expect(same).toMatchObject({ decision: 'unchanged', changed: [], blocks: [] });
    expect(same.candidate).toBeUndefined();

    const model = await runPromotionGate(options(subject(PROMPT_SAVE).value, subject(PROMPT_SAVE, { model: 'model-b' }).value));
    expect(model).toMatchObject({ decision: 'promote', changed: ['model'] });
    const harness = await runPromotionGate(options(subject(PROMPT_SAVE).value, subject(PROMPT_TALK, { sourceDigest: sha('harness v2'), model: 'model-b' }).value));
    expect(harness).toMatchObject({ decision: 'block', changed: ['harness', 'model', 'prompt'] });
  });
});

describe('what a verifier may not do', () => {
  const gate = (verifier: PostconditionVerifier) => runPromotionGate(options(subject(PROMPT_SAVE).value, subject(`${PROMPT_SAVE} Again.`).value,
    { verifiers: new PostconditionRegistry().register(verifier) }));

  it('cannot verify without evidence', async () => {
    const decision = await gate({ id: 'followup recorded', version: '1', verify: () => ({ status: 'verified', evidence: null }) });
    expect(decision.decision).toBe('block');
    expect(decision.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'failed', code: 'VERDICT_WITHOUT_EVIDENCE', evidence: null }]);
  });

  // A bare yes, a bare number and containers holding nothing say that the verifier answered, not
  // what it observed.
  const hollow: Array<[string, JsonValue]> = [
    ['an empty string', ''], ['a blank string', ' '], ['only whitespace', '\n\t '],
    ['false', false], ['true', true], ['zero', 0], ['a number', 1],
    ['an empty list', []], ['an empty object', {}],
    ['a list of nulls', [null]], ['an object of nulls', { a: null }],
    ['an object of blank text', { a: ' ' }], ['nested emptiness', { a: { b: [null, '', {}] } }],
  ];
  it.each(hollow)('cannot verify with %s as evidence', async (_label, evidence) => {
    const decision = await gate({ id: 'followup recorded', version: '1', verify: () => ({ status: 'verified', evidence }) });
    expect(decision.decision).toBe('block');
    expect(decision.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'failed', code: 'VERDICT_WITHOUT_EVIDENCE', evidence: null }]);
  });

  const observed: Array<[string, JsonValue]> = [
    ['a sentence', 'one scheduled row for the customer'], ['a count', { rows: 1 }],
    ['an observed absence', { duplicates: false }], ['a list of what was found', ['scheduled']],
  ];
  it.each(observed)('accepts %s as evidence', async (_label, evidence) => {
    const decision = await gate({ id: 'followup recorded', version: '1', verify: () => ({ status: 'verified', evidence }) });
    expect(decision.decision).toBe('promote');
    expect(decision.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'verified', evidence }]);
  });

  it('cannot return a verdict the gate does not know', async () => {
    const decision = await gate({ id: 'followup recorded', version: '1', verify: () => ({ status: 'done', evidence: { ok: true } }) as never });
    expect(decision.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'failed', code: 'INVALID_VERDICT', evidence: null }]);
    expect(decision.decision).toBe('block');
  });

  it('cannot pass the agent\'s message off as evidence', async () => {
    const candidate = subject(`${PROMPT_SAVE} Again.`);
    const run = candidate.value.run;
    // A careless harness copies the agent's message into the state it hands to verifiers.
    candidate.value.run = async (input, context) => {
      const result = await run(input, context);
      return { ...result, state: { ...(result.state as object), lastMessage: result.claim! } };
    };
    const echo: PostconditionVerifier = { id: 'followup recorded', version: '1',
      verify: ({ state }) => ({ status: 'verified', evidence: { said: (state as { lastMessage?: string }).lastMessage ?? 'nothing' } }) };
    const decision = await runPromotionGate(options(subject(PROMPT_SAVE).value, candidate.value, { verifiers: new PostconditionRegistry().register(echo) }));
    expect(decision.decision).toBe('block');
    expect(decision.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'failed', code: 'CLAIM_AS_EVIDENCE', evidence: null }]);
  });

  it('fails the postcondition when it throws or returns oversized evidence', async () => {
    const thrown = await gate({ id: 'followup recorded', version: '1', verify: () => { throw new Error('database unreachable at /private/path'); } });
    expect(thrown.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'failed', code: 'VERIFIER_ERROR', evidence: null }]);
    expect(JSON.stringify(thrown)).not.toContain('/private/path');
    const large = await gate({ id: 'followup recorded', version: '1', verify: () => ({ status: 'verified', evidence: 'x'.repeat(20_000) }) });
    expect(large.candidate?.attempts[0]?.postconditions).toEqual([{ id: 'followup recorded', status: 'failed', code: 'EVIDENCE_TOO_LARGE', evidence: null }]);
    expect(large.decision).toBe('block');
  });
});

describe('baselines and incomplete runs', () => {
  it('accepts the report recorded by an earlier promotion as the baseline', async () => {
    const first = await runPromotionGate(options(subject(PROMPT_SAVE).value, subject(`${PROMPT_SAVE} Be brief.`).value));
    expect(first.decision).toBe('promote');
    const recorded = JSON.parse(JSON.stringify({ report: first.candidate!.report, promptDigest: first.candidate!.promptDigest }));

    const candidate = subject(PROMPT_TALK);
    const second = await runPromotionGate(options(recorded, candidate.value));
    expect(second.decision).toBe('block');
    expect(second.changed).toEqual(['prompt']);
    expect(second.blocks).toEqual([{ code: 'POSTCONDITION_FAILED', postconditionId: 'followup recorded', failedAttempts: 2, regression: true }]);
    expect(second.baseline?.attempts).toEqual([]);
    expect(second.comparison?.baselineId).toBe(first.candidate!.report.id);
  });

  it('blocks when the recorded baseline cannot be compared with this evaluation', async () => {
    const first = await runPromotionGate(options(subject(PROMPT_SAVE).value, subject(`${PROMPT_SAVE} Be brief.`).value));
    const recorded = { report: first.candidate!.report, promptDigest: first.candidate!.promptDigest };
    const other = { ...suite, version: '2' };
    const decision = await runPromotionGate(options(recorded, subject(`${PROMPT_SAVE} Shorter.`).value, { suite: other }));
    expect(decision.decision).toBe('block');
    expect(decision.blocks).toEqual([{ code: 'BASELINE_INCOMPARABLE' }]);
    await expect(runPromotionGate(options({ report: { ...first.candidate!.report, digest: 'f'.repeat(64) }, promptDigest: recorded.promptDigest }, subject(PROMPT_TALK).value)))
      .rejects.toThrow('digest mismatch');
  });

  it('blocks when the candidate could not be evaluated in full', async () => {
    let admitted = 0;
    const budget = { acquire: async () => { if (++admitted > 3) throw new Error('no quota'); return { release() {} }; } };
    const candidate = subject(`${PROMPT_SAVE} Be brief.`);
    const decision = await runPromotionGate(options(subject(PROMPT_SAVE).value, candidate.value, { budget }));
    expect(decision.decision).toBe('block');
    expect(decision.blocks).toEqual([{ code: 'CANDIDATE_INCOMPLETE', planned: 2, completed: 1 }]);
    expect(decision.postconditions).toMatchObject([{ baseline: 'verified', candidate: 'not-verified' }]);
  });

  it('does not spend a candidate run when the baseline could not be evaluated', async () => {
    const budget = { acquire: async () => { throw new Error('no quota'); } };
    const candidate = subject(`${PROMPT_SAVE} Be brief.`);
    const decision = await runPromotionGate(options(subject(PROMPT_SAVE).value, candidate.value, { budget }));
    expect(decision.blocks).toEqual([{ code: 'BASELINE_INCOMPLETE', planned: 2, completed: 0 }]);
    expect(candidate.runs).toEqual([]);
    expect(decision.candidate).toBeUndefined();
  });

  it('lets an already broken baseline be replaced by a candidate that verifies', async () => {
    const decision = await runPromotionGate(options(subject(PROMPT_TALK).value, subject(PROMPT_SAVE).value));
    expect(decision).toMatchObject({ decision: 'promote', postconditions: [{ baseline: 'failed', candidate: 'verified' }] });
  });
});

describe('gate input validation', () => {
  const good = () => options(subject(PROMPT_SAVE).value, subject(PROMPT_TALK).value);
  it('rejects malformed input before running anything', async () => {
    await expect(runPromotionGate({ ...good(), id: 'bad id' })).rejects.toThrow();
    await expect(runPromotionGate({ ...good(), postconditions: [...declared, ...declared] })).rejects.toThrow('Duplicate');
    await expect(runPromotionGate({ ...good(), postconditions: [{ id: ' ', description: 'x' }] })).rejects.toThrow();
    await expect(runPromotionGate({ ...good(), candidate: { ...subject(PROMPT_TALK).value, promptDigest: 'not-a-digest' } })).rejects.toThrow();
    await expect(runPromotionGate({ ...good(), verifiers: [followupRecorded] as never })).rejects.toThrow();
    await expect(runPromotionGate({ ...good(), candidate: { profile: good().candidate.profile, promptDigest: sha('x') } as never })).rejects.toThrow();
  });

  it('keeps one verifier per postcondition id', () => {
    const registry = new PostconditionRegistry().register(followupRecorded);
    expect(registry.get('followup recorded')?.version).toBe('1');
    expect(registry.get('unknown')).toBeUndefined();
    expect(() => registry.register(followupRecorded)).toThrow('already registered');
    expect(() => registry.register({ id: '', version: '1', verify: () => ({ status: 'failed', evidence: null }) })).toThrow();
    expect(() => registry.register({ id: 'x', version: '1' } as never)).toThrow();
  });
});
