// Runs an actual SDK turn against a deterministic local CLI.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Runtime } from 'hiveagents-runtime';
import { runProcess } from 'hiveagents-runtime/adapter-kit';

const provider = 'local-counter';
const model = { id: 'words', provider, aliases: [], source: 'explicit', availability: 'available' };
const program = `
  const text = require('node:fs').readFileSync(0, 'utf8').trim();
  const words = text ? text.split(/\\s+/u).length : 0;
  process.stdout.write(JSON.stringify({ words, sessionId: require('node:crypto').randomUUID() }));
`;
const target = { command: process.execPath, argsPrefix: ['-e', program] };

function adapter(launch) {
  return {
    id: provider,
    async detect() { return { installed: true, version: process.version, launchTarget: launch }; },
    async auth() { return { authenticated: false, state: 'unknown', source: 'oss' }; },
    async models() { return [model]; },
    async execute(request) {
      const result = await runProcess({
        command: launch.command, args: launch.argsPrefix, cwd: request.cwd, env: request.env,
        stdin: request.prompt, signal: request.signal, timeoutMs: request.timeoutMs, maxOutputBytes: 128,
      });
      assert.equal(result.code, 0);
      const { words, sessionId } = JSON.parse(result.stdout);
      assert.ok(Number.isSafeInteger(words) && words >= 0);
      assert.match(sessionId, /^[a-f0-9-]{36}$/u);
      return { completed: true, failed: false, refused: false, sessionId, text: String(words), events: [], nativeEvents: [] };
    },
  };
}

const runtime = new Runtime({ providers: [{
  apiVersion: 1, id: provider, modelCatalog: [model],
  resolveModel(id) {
    assert.equal(id, model.id);
    return model;
  },
  exec: { token: 'localCounterExecV1', adapterVersion: '1.0.0', adapter: adapter(target), withTarget: adapter },
  execCapabilities: { turns: 'supported', structuredOutput: 'unsupported', resume: 'unsupported' },
  validateOptions(options) {
    assert.equal(options.environment.mode, 'minimal');
  },
  translateContext({ profile = 'native', memory = 'inherit' } = {}) {
    assert.equal(profile, 'native');
    assert.equal(memory, 'inherit');
    return { args: [], unsupported: [], warnings: [], report: { profile, memory, active: [], inactive: [], unavoidable: [], unknown: [] } };
  },
  translatePermissions(requested) {
    assert.equal(requested.mode, 'analyze');
    return { args: [], report: { requested, unsupported: [], warnings: [],
      effective: { filesystem: 'stdin y stdout', network: 'el contador local no usa red', approvals: 'sin herramientas', enforcedBy: [] } } };
  },
}] });

const cwd = await mkdtemp(join(tmpdir(), 'hiveagents-quickstart-'));
const agent = new Agent({
  cwd, model: provider + '/' + model.id, transport: 'exec', environment: { mode: 'minimal' },
  permissions: { mode: 'analyze' },
}, runtime);
try {
  const turn = await agent.run('Revisar una tarjeta', { timeoutMs: 5000, awaitSettlement: true });
  assert.equal(turn.status, 'completed');
  assert.equal(turn.text, '3');
  console.log(JSON.stringify({ status: turn.status, words: Number(turn.text), model: provider + '/' + model.id }));
} finally {
  await agent.close();
  await rm(cwd, { recursive: true, force: true });
}
