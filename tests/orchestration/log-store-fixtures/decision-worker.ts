import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LogExecutionDatabase } from '../../../src/orchestration/log/execution-database.js';
import { LogDecisionStore } from '../../../src/orchestration/log/decision-store.js';
import { DecisionRunner } from '../../../src/orchestration/decisions/runner.js';
import { WorkflowRunner } from '../../../src/orchestration/workflow/runner.js';
import { LogWorkflowStore } from '../../../src/orchestration/log/workflow-store.js';
import { bindDecision } from '../../../src/orchestration/decisions/binding.js';
import { isExecutionHalted } from '../../../src/public/execution-halt.js';
import { logDraft } from '../log-store-fixture.js';
import type { DecisionStore } from '../../../src/orchestration/decisions/types.js';
const [file, target, mode] = process.argv.slice(2); if (!file || !target) throw Error('owned fixture arguments missing');
const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }), identity = logDraft().identity;
const association = { identity, stepId: 'effect', effectKey: 'effect', operation: { id: 'owned-write', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
const actual = new LogDecisionStore({ database, association });
const store: DecisionStore = { async acquire(id) {
  const lease = await actual.acquire(id); return { ...lease, async save(record) {
    await lease.save(record); if (mode === 'intent' && record.status === 'intent' || mode === 'dispatched' && record.status === 'dispatched') process.kill(process.pid, 'SIGKILL');
  } };
} };
if (mode === 'verified' || mode === 'ackloss') {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    original.call(this, sql);
    if (sql === 'COMMIT' && this.prepare("SELECT 1 FROM main.oar_execution_states WHERE kind='decision' AND json_extract(record_json,'$.status')='verified'").get()) {
      if (mode === 'verified') process.kill(process.pid, 'SIGKILL'); throw Error('owned COMMIT ack loss');
    }
  };
}
const runDecision = () => new DecisionRunner(store).run({ id: 'decision', binding: bindDecision({ input: { z: 'first', a: 'second' }, authority: null, inputVersion: '1', authorityVersion: '1' }),
    authorize: () => ({ decision: 'allow', reason: 'owned fixture', expiresAt: Date.now() + 10000 }), isCurrent: () => true,
    execute: () => {
      const fd = openSync(target, 'a', 0o600); try { writeSync(fd, 'owned-effect\n'); fsyncSync(fd); } finally { closeSync(fd); }
      if (mode === 'effect' || mode === 'wf-effect') process.kill(process.pid, 'SIGKILL'); return { original: 'owned-result' };
    }, verify: () => ({ verified: readFileSync(target, 'utf8') === 'owned-effect\n', evidence: ['owned:file:one-effect'] }),
  });
try {
  if (mode?.startsWith('wf-')) {
    const definition = { id: 'owned-workflow', version: '1', steps: [{ id: 'effect', replaySafe: true, maxAttempts: 3, execute: async () => (await runDecision()).result ?? null }] };
    const checkpoint = await new WorkflowRunner(new LogWorkflowStore({ database, identity, definition })).run(definition, { runId: identity.runId, recoverInterrupted: 'replay-safe' });
    process.stdout.write(JSON.stringify({ status: checkpoint.status }));
  } else { const result = await runDecision(); process.stdout.write(JSON.stringify({ status: result.status, result: result.result ?? null })); }
} catch (error) { process.stdout.write(JSON.stringify({ halted: isExecutionHalted(error) })); }
database.close();
