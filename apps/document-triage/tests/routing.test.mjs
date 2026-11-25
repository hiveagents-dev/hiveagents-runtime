import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Runtime, createClaudeProvider, createCodexProvider, createCodexControlRegistration } from 'hiveagents-runtime';
import { selectDocumentAgent, classifyWithSelectedAgent } from '../dist/routing-agent.js';
import { routingDeadline } from '../dist/routing-deadline.js';
import { performance } from 'node:perf_hooks';
import { mock } from 'node:test';

const main = new URL('../dist/main.js', import.meta.url).pathname;
const fixture = name => new URL(`./fixtures/fake-${name}.mjs`, import.meta.url).pathname;
const baseConfig = { transport: 'exec', requireAuth: 'any', permissions: { mode: 'analyze' } };
const automatic = overrides => ({ mode: 'auto', candidates: ['gemini/gemini-2.5-flash', 'antigravity/gemini-3-flash'],
  allowUnverifiedModels: true, allowUnknownAuth: true, ...overrides });

async function scenario(execute) {
  const directory = await mkdtemp(join(tmpdir(), 'oar-routing-app-'));
  const calls = join(directory, 'calls.jsonl');
  const env = { ...process.env, GEMINI_API_KEY: 'fixture-not-a-credential',
    OAR_GEMINI_COMMAND: process.execPath, OAR_GEMINI_ARGS_JSON: JSON.stringify([fixture('gemini')]),
    OAR_ANTIGRAVITY_COMMAND: process.execPath, OAR_ANTIGRAVITY_ARGS_JSON: JSON.stringify([fixture('antigravity')]),
    OAR_FIXTURE_CALLS: calls };
  const invoke = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [main, ...args], { env: { ...env, ...extra }, cwd: directory,
      encoding: 'utf8', timeout: 30000 });
    return { ...result, json: result.status === 0 ? JSON.parse(result.stdout) : undefined };
  };
  const config = async (model, mode = 'analyze') => {
    const path = join(directory, 'agent.json');
    await writeFile(path, JSON.stringify({ ...baseConfig, permissions: { mode }, model })); return path;
  };
  const turns = async () => { try { return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };
  try { await execute({ directory, env, invoke, config, turns }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('fixed selection sends no prompt and its proposal is readable in another process', () => scenario(async ({ directory, invoke, config, turns }) => {
  const path = await config('gemini/gemini-2.5-flash');
  const selected = invoke(['route-select', '--config', path, '--state-dir', directory, '--id', 'fixed']);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.json.receipt.reason, 'FIXED');
  assert.equal(selected.json.receipt.selected.model, 'gemini/gemini-2.5-flash');
  assert.equal(selected.json.requestedModelTurns, 0);
  assert.equal(selected.json.routingApiCalls, 0);
  assert.equal(await turns(), 0);
  const inspected = invoke(['route-inspect', '--state-dir', directory, '--id', 'fixed']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.notEqual(inspected.json.pid, selected.json.pid);
  assert.deepEqual(inspected.json.receipt, selected.json.receipt);
  const withoutProviders = invoke(['route-inspect', '--state-dir', directory, '--id', 'fixed'], { OAR_GEMINI_COMMAND: 'invalid-relative-path' });
  assert.equal(withoutProviders.status, 0, withoutProviders.stderr);
  const duplicate = invoke(['route-select', '--config', path, '--state-dir', directory, '--id', 'fixed']);
  assert.notEqual(duplicate.status, 0);
  const stored = (await readdir(join(directory, 'routing'))).find(name => name.endsWith('.json'));
  const checkpoint = join(directory, 'routing', stored);
  await writeFile(checkpoint, (await readFile(checkpoint, 'utf8')).replace('selection-proposal', 'tampered-proposal'));
  assert.notEqual(invoke(['route-inspect', '--state-dir', directory, '--id', 'fixed']).status, 0);
  assert.equal(await turns(), 0);
}));

test('auto respects priority, provider allowlists, tag rules and explicit fallback', () => scenario(async ({ directory, invoke, config, turns }) => {
  for (const [id, model, tags, expected, reason, mode] of [
    ['priority', automatic({}), undefined, 'gemini/gemini-2.5-flash', 'PRIORITY', 'analyze'],
    ['allowlist', automatic({ providers: ['antigravity'] }), undefined, 'antigravity/gemini-3-flash', 'PRIORITY', 'edit'],
    ['rule', automatic({ rules: [{ id: 'review', allTags: ['review'], models: ['antigravity/gemini-3-flash'] }] }), 'review', 'antigravity/gemini-3-flash', 'RULE', 'edit'],
    ['fallback', automatic({ rules: [{ id: 'review', allTags: ['review'], models: ['gemini/gemini-2.5-flash'] }], fallback: 'antigravity/gemini-3-flash' }), 'other', 'antigravity/gemini-3-flash', 'FALLBACK', 'edit'],
  ]) {
    const path = await config(model, mode);
    const result = invoke(['route-select', '--config', path, '--state-dir', directory, '--id', id,
      ...(tags === undefined ? [] : ['--tags', tags])]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.receipt.selected.model, expected);
    assert.equal(result.json.receipt.reason, reason);
  }
  assert.equal(await turns(), 0);
}));

test('classify dispatches exactly one selected fixture turn; receipts contain no document or credential', () => scenario(async ({ directory, invoke, config, turns }) => {
  const path = await config(automatic({})), input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify([{ id: 'vpn', text: 'CANARY_ROUTING_SOURCE VPN certificate expired.' }]));
  const result = invoke(['route-classify', '--config', path, '--input', input, '--state-dir', directory,
    '--id', 'classify', '--max-launches', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.classification.category, 'network');
  assert.equal(result.json.requestedModelTurns, 1);
  assert.equal(result.json.modelLaunches, null);
  assert.equal(result.json.receipt.nativeDispatches, 0);
  assert.equal(await turns(), 1);
  const stored = invoke(['route-inspect', '--state-dir', directory, '--id', 'classify']);
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.stringify(stored.json).includes('CANARY_ROUTING_SOURCE'), false);
  assert.equal(JSON.stringify(stored.json).includes('fixture-not-a-credential'), false);
}));

test('invalid input and a missing launch budget fail before selection or dispatch', () => scenario(async ({ directory, invoke, config, turns }) => {
  const path = await config(automatic({})), input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify([]));
  const args = ['route-classify', '--config', path, '--input', input, '--state-dir', directory];
  assert.notEqual(invoke(args).status, 0);
  assert.notEqual(invoke([...args, '--max-launches', '1']).status, 0);
  assert.equal(await turns(), 0);
  assert.equal((await readdir(directory)).includes('routing'), false);
}));

test('the application rejects JSON environment overrides before selection', () => scenario(async ({ directory, invoke, config, turns }) => {
  const path = await config('gemini/gemini-2.5-flash');
  await writeFile(path, JSON.stringify({ ...baseConfig, model: 'gemini/gemini-2.5-flash',
    environment: { mode: 'explicit', variables: { NODE_OPTIONS: '--invalid-canary-option' } } }));
  const result = invoke(['route-select', '--config', path, '--state-dir', directory, '--id', 'environment']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /application controls.*environment/i);
  assert.equal((await readdir(directory)).includes('routing'), false);
  assert.equal(await turns(), 0);
}));

test('selection never widens Antigravity permissions to make a candidate eligible', () => scenario(async ({ directory, invoke, config, turns }) => {
  const path = await config('antigravity/gemini-3-flash');
  await writeFile(path, JSON.stringify({ ...baseConfig, permissions: { mode: 'analyze' }, model: 'antigravity/gemini-3-flash' }));
  const result = invoke(['route-select', '--config', path, '--state-dir', directory, '--id', 'denied']);
  assert.notEqual(result.status, 0);
  const inspected = invoke(['route-inspect', '--state-dir', directory, '--id', 'denied']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.json.receipt.decision, 'abstained');
  assert.equal(inspected.json.receipt.candidates[0].code, 'POLICY_UNSUPPORTED');
  assert.equal(await turns(), 0);
}));

test('execution failure and deadline do not retry another provider', () => scenario(async ({ directory, invoke, config, turns }) => {
  const path = await config(automatic({ candidates: ['antigravity/gemini-3-flash', 'gemini/gemini-2.5-flash'] }), 'edit');
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify([{ id: 'vpn', text: 'VPN failure.' }]));
  for (const mode of ['failure', 'wait']) {
    const before = await turns();
    const result = invoke(['route-classify', '--config', path, '--input', input, '--state-dir', directory,
      '--id', mode, '--max-launches', '1', '--timeout-ms', mode === 'wait' ? '5000' : '20000'],
    { OAR_ANTIGRAVITY_FIXTURE_MODE: mode });
    assert.notEqual(result.status, 0);
    assert.equal(await turns(), before + 1);
  }
}));

test('deadline boundary rejects elapsed time before the event-loop timer runs and preserves TIMEOUT', () => {
  let now = 0;
  const clock = mock.method(performance, 'now', () => now);
  const deadline = routingDeadline(10);
  try {
    assert.equal(deadline.remaining(), 10);
    now = 11;
    assert.throws(() => deadline.remaining(), error => error.code === 'TIMEOUT');
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.signal.reason.code, 'TIMEOUT');
  } finally { deadline.dispose(); clock.mock.restore(); }
});

function mockedProvider(provider, authenticated = true, calls = () => {}) {
  const adapter = { id: provider.id,
    detect: async () => ({ installed: true, version: provider.id === 'claude' ? '2.1.116' : '0.149.0' }),
    auth: async () => ({ authenticated, state: authenticated ? 'authenticated' : 'not-authenticated', source: 'subscription' }),
    models: async () => { throw new Error('Dynamic catalog must not be used'); },
    execute: async () => { calls(); throw new Error('Unexpected native dispatch'); } };
  return { ...provider, exec: { ...provider.exec, adapter, withTarget: () => adapter } };
}

test('configuration is snapshotted before a caller can add a late environment override', () => scenario(async ({ directory }) => {
  const provider = mockedProvider(createCodexProvider());
  let observed;
  provider.exec.adapter.detect = async env => { observed = env.OAR_CANARY_MUTATION; return { installed: true, version: '0.149.0' }; };
  const runtime = new Runtime({ providers: [provider] });
  const definition = { model: `codex/${provider.modelCatalog[0].id}`, transport: 'exec' };
  const pending = selectDocumentAgent({ runtime, definition, stateDirectory: directory, id: 'snapshot' });
  definition.environment = { mode: 'explicit', variables: { OAR_CANARY_MUTATION: 'changed' } };
  const selected = await pending;
  assert.equal(selected.receipt.decision, 'selected');
  assert.equal(observed, undefined);
}));

test('public app integration preserves fixed Claude/Codex and filters explicit negative auth', () => scenario(async ({ directory }) => {
  for (const provider of [createClaudeProvider(), createCodexProvider()]) {
    let native = 0;
    const runtime = new Runtime({ providers: [mockedProvider(provider, true, () => native++)] });
    const model = `${provider.id}/${provider.modelCatalog[0].id}`;
    const selected = await selectDocumentAgent({ runtime, definition: { model, transport: 'exec' }, stateDirectory: directory, id: provider.id });
    assert.equal(selected.receipt.selected.provider, provider.id);
    assert.equal(native, 0);
    const denied = new Runtime({ providers: [mockedProvider(provider, false)] });
    await assert.rejects(selectDocumentAgent({ runtime: denied,
      definition: { model: { mode: 'auto', candidates: [model], allowUnverifiedModels: true, allowUnknownAuth: true } },
      stateDirectory: directory, id: `denied-${provider.id}` }), error => error.receipt.candidates[0].code === 'AUTH_REQUIRED');
  }
}));

test('control selection is inspectable but classification rejects before transport/session opening', () => scenario(async ({ directory }) => {
  let opened = 0;
  const provider = createCodexProvider();
  const runtime = new Runtime({ providers: [{ ...mockedProvider(provider),
    control: createCodexControlRegistration({ startTransport: async () => { opened++; throw new Error('Must not open control'); } }) }] });
  await assert.rejects(classifyWithSelectedAgent({ runtime, stateDirectory: directory, id: 'control', maxLaunches: 1,
    definition: { model: `codex/${provider.modelCatalog[0].id}`, transport: 'control', providerOptions: { experimentalControl: true, experimentalApi: true } },
    documents: [{ id: 'one', text: 'VPN note' }] }), /requires an exec selection/);
  assert.equal(opened, 0);
}));


function nativeProviderOverrides(settingsPath) {
  return [
    { claude: { settings: { env: { ANTHROPIC_BASE_URL: 'https://canary.invalid', ANTHROPIC_API_KEY: 'CANARY_NATIVE_CONFIG' } } } },
    { claude: { settings: '{"env":{"ANTHROPIC_BASE_URL":"https://canary.invalid"}}' } },
    { claude: { settings: settingsPath } },
    { codex: { config: { model_provider: 'canary', model_providers: { canary: { base_url: 'https://canary.invalid' } } } } },
    { external: { gemini: { environment: { GEMINI_API_KEY: 'CANARY_NATIVE_CONFIG' } } } },
  ];
}

test('app helpers reject every native provider configuration before readiness, state or dispatch', () => scenario(async ({ directory }) => {
  let detected = 0, dispatched = 0;
  const provider = mockedProvider(createClaudeProvider(), true, () => dispatched++);
  provider.exec.adapter.detect = async () => { detected++; return { installed: true, version: '2.1.116' }; };
  const runtime = new Runtime({ providers: [provider] });
  const state = join(directory, 'rejected-state');
  for (const providerOptions of [...nativeProviderOverrides(join(directory, 'native-settings.json')),
    { experimentalControl: 'true' }, null, []]) {
    await assert.rejects(selectDocumentAgent({ runtime, definition: {
      model: `claude/${provider.modelCatalog[0].id}`, transport: 'exec', providerOptions,
    }, stateDirectory: state }), /application controls.*provider|providerOptions/i);
  }
  assert.equal(detected, 0); assert.equal(dispatched, 0);
  assert.equal((await readdir(directory)).includes('rejected-state'), false);
}));

test('CLI rejects native settings objects, JSON strings, file paths and Codex config before selection', () => scenario(async ({ directory, invoke, turns }) => {
  const settingsPath = join(directory, 'native-settings.json');
  await writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://canary.invalid' } }));
  const path = join(directory, 'agent.json'), state = join(directory, 'rejected-state');
  for (const providerOptions of nativeProviderOverrides(settingsPath)) {
    await writeFile(path, JSON.stringify({ ...baseConfig, model: 'gemini/gemini-2.5-flash', providerOptions }));
    const result = invoke(['route-select', '--config', path, '--state-dir', state]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /application controls.*provider|providerOptions/i);
    assert.equal((await readdir(directory)).includes('rejected-state'), false);
  }
  assert.equal(await turns(), 0);
}));

test('snapshots caller options and tags synchronously while retaining the original runtime reference', () => scenario(async ({ directory }) => {
  let originalProbes = 0, replacementProbes = 0;
  const provider = mockedProvider(createCodexProvider());
  provider.exec.adapter.detect = async () => { originalProbes++; return { installed: true, version: '0.149.0' }; };
  const replacement = mockedProvider(createCodexProvider());
  replacement.exec.adapter.detect = async () => { replacementProbes++; return { installed: true, version: '0.149.0' }; };
  const runtime = new Runtime({ providers: [provider] }), model = `codex/${provider.modelCatalog[0].id}`;
  const definition = { model: { mode: 'auto', candidates: [model], allowUnverifiedModels: true,
    rules: [{ id: 'original-rule', allTags: ['original'], models: [model] }] }, transport: 'exec' };
  const options = { runtime, definition, stateDirectory: join(directory, 'original-state'), id: 'original-id', tags: ['original'] };
  const pending = selectDocumentAgent(options);
  options.id = 'other-id'; options.tags[0] = 'other'; options.stateDirectory = join(directory, 'other-state');
  options.runtime = new Runtime({ providers: [replacement] });
  const selected = await pending;
  const stable = await selectDocumentAgent({ runtime, definition, stateDirectory: join(directory, 'stable-state'), id: 'stable-id', tags: ['original'] });
  assert.equal(selected.receipt.id, 'original-id');
  assert.equal(selected.receipt.policy.ruleId, 'original-rule');
  assert.equal(selected.receipt.selected.model, model);
  assert.equal(selected.receipt.sourceDigest, stable.receipt.sourceDigest);
  assert.equal(selected.receipt.taskDigest, stable.receipt.taskDigest);
  assert.equal(originalProbes, 2); assert.equal(replacementProbes, 0);
  assert.equal((await readdir(directory)).includes('other-state'), false);
  assert.ok((await readdir(join(directory, 'original-state', 'routing'))).some(file => file.endsWith('.json')));
}));
