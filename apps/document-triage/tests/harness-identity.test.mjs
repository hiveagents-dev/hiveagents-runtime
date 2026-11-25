import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Runtime } from 'hiveagents-runtime';
import { createAppRuntime } from '../dist/runtime.js';
import { executionIdentity, installedRuntimeBuilds, runtimePackageBuildDigest } from '../dist/harness-identity.js';
import { harnessIdentity } from '../dist/harness-common.js';

test('installed runtime identity binds all three actual public package builds and chunks', async () => {
  const builds = await installedRuntimeBuilds();
  assert.deepEqual(builds.map(item => item.name), ['hiveagents-runtime']);
  assert.ok(builds.every(item => /^[a-f0-9]{64}$/.test(item.digest)));
  const directory = await mkdtemp(join(tmpdir(), 'oar-build-identity-'));
  try {
    const entry = fileURLToPath(import.meta.resolve('hiveagents-runtime'));
    await cp(dirname(entry), directory, { recursive: true });
    const copiedEntry = pathToFileURL(join(directory, 'index.js')).href;
    const before = await runtimePackageBuildDigest(copiedEntry);
    await writeFile(join(directory, 'changed-runtime-chunk.js'), 'export const changed = true;\n');
    assert.notEqual(await runtimePackageBuildDigest(copiedEntry), before);
    assert.equal((await harnessIdentity()).digest, (await harnessIdentity()).digest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('execution configuration fingerprints executable, script bytes, args and cwd without persisting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oar-launch-identity-'));
  try {
    const script = join(directory, 'fixture.mjs'); await writeFile(script, 'console.log("one")');
    const create = args => createAppRuntime({ geminiExecutable: { command: process.execPath, argsPrefix: args } });
    const get = runtime => executionIdentity(runtime, { provider: 'gemini', id: 'gemini-2.5-flash' }, directory);
    const first = await get(create([script, '--secret', 'fixture-secret-canary']));
    assert.equal(first.attestation, 'configuration-only');
    await writeFile(script, 'console.log("two")');
    assert.notEqual((await get(create([script, '--secret', 'fixture-secret-canary']))).digest, first.digest);
    assert.notEqual((await get(create([script, '--secret', 'different']))).digest, first.digest);
    const subdir = join(directory, 'other'); await mkdir(subdir);
    assert.notEqual((await executionIdentity(create([script]), { provider: 'gemini', id: 'gemini-2.5-flash' }, subdir)).digest, (await get(create([script]))).digest);
    assert.equal(JSON.stringify(first).includes(directory), false); assert.equal(JSON.stringify(first).includes('fixture-secret-canary'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('programmatic unrecognized runtime identities remain unattested and do not claim a stable execution profile', async () => {
  const custom = new Runtime();
  const first = await executionIdentity(custom, { provider: 'claude', id: 'claude-opus-5' }, process.cwd());
  const second = await executionIdentity(custom, { provider: 'claude', id: 'claude-opus-5' }, process.cwd());
  assert.equal(first.attestation, 'custom-runtime-unattested'); assert.notEqual(first.digest, second.digest);
});
