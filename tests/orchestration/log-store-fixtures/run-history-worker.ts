// Own Node CLI only. Public built package imports exercise the consumer contract, never installed providers.
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Agent, Runtime, ClaudeExecAdapter } from 'hiveagents-runtime';
import type { ExecAdapter, ExecTurnRequest } from 'hiveagents-runtime';
import { DecisionRunner, bindDecision } from 'hiveagents-runtime/orchestration';
import { LogExecutionDatabase, LogDecisionStore, createRunHistory, createLogTraceProjector, createLogAuditProjector, inspectManagedEffect } from 'hiveagents-runtime/orchestration/log';

const [file, target, mode, cli] = process.argv.slice(2); if (!file || !target || !cli) throw Error('Owned fixture arguments missing');
const ownedCli = cli;
const identity = { systemId: 'fixture', generation: 1, runId: 'task', agentId: 'declarative', harness: { id: 'fixture', version: '1', digest: 'a'.repeat(64) } };
const association = { identity, stepId: 'write', effectKey: 'write-once', operation: { id: 'owned-write', version: '1', targetDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) } };
const database = new LogExecutionDatabase({ databasePath: file, systemId: 'fixture' }), history = createRunHistory({ database });
const start = await history.begin({ identity, requestId: 'task:begin', inputDigest: 'd'.repeat(64) });
let agentIdentity: typeof identity | undefined;
if (start.kind === 'started') {
  class OwnedCli implements ExecAdapter {
    readonly id = 'claude'; readonly delegate = new ClaudeExecAdapter({ target: { command: process.execPath, argsPrefix: [ownedCli, 'claude'] } });
    async detect() { return { installed: true, path: process.execPath, version: '1.0.0' }; }
    async auth() { return { authenticated: true, source: 'subscription' as const }; }
    async models() { return []; }
    execute(request: ExecTurnRequest) { return this.delegate.execute(request); }
    stream(request: ExecTurnRequest) { return this.delegate.stream(request); }
  }
  const runtime = new Runtime({ adapters: [new OwnedCli()], capture: { store: database.captureStore, identity } });
  const agent = new Agent({ model: 'claude/opus', transport: 'exec' }, runtime);
  try {
    const result = await agent.send('fixture', { awaitSettlement: true }); agentIdentity = agent.logIdentity;
    await new DecisionRunner(new LogDecisionStore({ database, association })).run({ id: 'write',
      binding: bindDecision({ input: { task: 'fixture' }, authority: null, inputVersion: '1', authorityVersion: '1' }),
      authorize: () => ({ decision: 'allow', reason: 'owned fixture only', expiresAt: Date.now() + 5000 }), isCurrent: () => true,
      execute: () => { appendFileSync(target, 'effect\n', { mode: 0o600, flush: true }); if (mode === 'crash') process.kill(process.pid, 'SIGKILL'); return null; },
      verify: () => ({ verified: readFileSync(target, 'utf8') === 'effect\n', evidence: ['owned:file:one'] }),
    });
    await history.complete(start.run, { requestId: 'task:complete', outputDigest: createHash('sha256').update(result.text).digest('hex') });
  } finally { await agent.close(); }
}
const page = await database.readPage({ limit: 256 });
// Agent identities are recovered from the same committed source, not a private runs.sqlite.
agentIdentity ??= page.items.find(entry => entry.record.schema.id === 'oar.sdk.capture-operation')?.record.identity;
const trace = agentIdentity ? await createLogTraceProjector({ reader: database, identity: agentIdentity }).rebuild() : undefined;
const audit = await createLogAuditProjector({ reader: database, identity }).rebuild();
process.stdout.write(JSON.stringify({ kind: start.kind, record: await history.recover(identity), list: await history.list({ generation: 1 }),
  source: database.sourceId, sources: [...new Set(page.items.map(entry => entry.sourceId))], events: page.items.map(entry => entry.record.type),
  trace: trace && { kind: trace.kind, events: trace.items.filter(item => item.category === 'agent-event').length },
  audit: { kind: audit.kind, runMarkers: audit.items.filter(item => item.category === 'run').length, decisions: audit.items.filter(item => item.category === 'decision').length },
  effect: inspectManagedEffect(database, association)?.record?.status }));
database.close();
