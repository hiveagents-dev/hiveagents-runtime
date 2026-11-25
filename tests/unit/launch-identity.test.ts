import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, Runtime } from '../../src/index.js';
import { registrationFixture } from './fixtures/provider-registration.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe('full launch identity', () => {
  it('preserves node plus script and re-probes changed script bytes under the same node executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oar-identity-')); dirs.push(dir);
    const script = join(dir, 'fixture.mjs'); await writeFile(script, 'first');
    const fixture = registrationFixture();
    const target = { command: process.execPath, argsPrefix: [script, '--fixed'] };
    fixture.setInstallation({ installed: true, version: '1.0.0', path: process.execPath, launchTarget: target, identityFiles: [script] });
    const targets: unknown[] = [];
    let probes = 0;
    const originalDetect = fixture.registration.exec.adapter.detect;
    fixture.registration.exec.adapter.detect = async (env) => { probes += 1; return originalDetect(env); };
    fixture.registration.exec.withTarget = (value) => { targets.push(value); return fixture.registration.exec.adapter; };
    const agent = new Agent({ model: 'fixture' }, new Runtime({ providers: [fixture.registration] }));
    const ready = await agent.ready();
    expect(targets).toEqual([{ command: await realpath(process.execPath), argsPrefix: [await realpath(script), '--fixed'] }]);
    expect(ready.plan.fingerprint.launchIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    const session = await agent.openSession();
    await session.send('first');
    expect(probes).toBe(1);
    await writeFile(script, 'other');
    await session.send('second');
    expect(probes).toBe(2);
    await session.close();
  });
  it('fails readiness if an explicitly declared launch identity file is missing', async () => {
    const fixture = registrationFixture();
    fixture.setInstallation({ installed: true, path: process.execPath, identityFiles: ['/missing-oar-script.mjs'] });
    await expect(new Agent({ model: 'fixture' }, new Runtime({ providers: [fixture.registration] })).ready()).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  it('refuses a changed launch when required capability evidence disappears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oar-identity-')); dirs.push(dir);
    const script = join(dir, 'fixture.mjs'); await writeFile(script, 'first');
    const fixture = registrationFixture();
    fixture.setInstallation({ installed: true, version: '1.0.0', path: process.execPath,
      launchTarget: { command: process.execPath, argsPrefix: [script] }, identityFiles: [script] });
    let changed = false;
    fixture.registration.exec.adapter.compatibility = async () => changed ? undefined : ({
      provider: fixture.registration.id, cliVersion: '1.0.0', transport: 'exec',
      evidence: 'live-contract', features: { turns: 'supported', forkWithPrompt: 'supported' },
      missingFlags: [], knownIssues: [],
    });
    const agent = new Agent({ model: 'fixture', capabilities: { forkWithPrompt: 'required' } },
      new Runtime({ providers: [fixture.registration] }));
    const session = await agent.openSession();
    await session.send('first');
    changed = true;
    await writeFile(script, 'changed');
    await expect(session.send('second')).rejects.toThrow(/Required capability forkWithPrompt is unknown/);
    expect(fixture.requests).toHaveLength(1);
    await session.close();
  });

  it('binds a script alias to its canonical identity before a later alias swap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oar-identity-')); dirs.push(dir);
    const script = join(dir, 'first.mjs');
    const other = join(dir, 'other.mjs');
    const alias = join(dir, 'alias.mjs');
    await writeFile(script, 'first');
    await writeFile(other, 'other');
    await symlink(script, alias);
    const fixture = registrationFixture();
    fixture.setInstallation({ installed: true, version: '1.0.0', path: process.execPath,
      launchTarget: { command: process.execPath, argsPrefix: [alias] }, identityFiles: [await realpath(script)] });
    const targets: { command: string; argsPrefix: string[] }[] = [];
    fixture.registration.exec.withTarget = (target) => { targets.push(target); return fixture.registration.exec.adapter; };
    const agent = new Agent({ model: 'fixture' }, new Runtime({ providers: [fixture.registration] }));
    await agent.ready();
    await rm(alias);
    await symlink(other, alias);
    expect(targets[0]?.argsPrefix).toEqual([await realpath(script)]);
    await agent.close();
  });
});
