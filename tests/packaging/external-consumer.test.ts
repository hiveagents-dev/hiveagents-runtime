import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const moduleUrl = pathToFileURL(resolve('scripts/verify-external-consumer.mjs')).href;
const verifier = await import(moduleUrl);
const directories: string[] = [];
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'oar-external-audit-'));
  directories.push(path);
  return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('external consumer acceptance boundary', () => {
  it('requires the SDK tarball and rejects unknown or duplicate arguments', () => {
    expect(verifier.parseArguments(['--core-tarball', '/tmp/core.tgz'])).toEqual({ coreTarball: '/tmp/core.tgz' });
    expect(() => verifier.parseArguments([])).toThrow(/core-tarball/);
    expect(() => verifier.parseArguments(['--core-tarball', 'core.tgz', '--adapter-tarball', 'adapter.tgz']))
      .toThrow(/Unknown argument/);
    expect(() => verifier.parseArguments(['--unknown', 'x'])).toThrow(/Unknown/);
    expect(() => verifier.parseArguments(['--core-tarball', 'a', '--core-tarball', 'b'])).toThrow(/duplicate/);
  });

  it('accepts only the public package entries and relative app modules', () => {
    expect(() => verifier.auditSourceImports("import { Agent } from 'hiveagents-runtime';\n"
      + "import { WorkflowRunner } from 'hiveagents-runtime/orchestration';\n"
      + "import { createAgent } from 'hiveagents-runtime/routing';\n"
      + "import { LearningRouter } from 'hiveagents-runtime/routing/learning';\n"
      + "import { resolveBinaryCandidates } from 'hiveagents-runtime/adapter-kit';\n"
      + "import { createGeminiCliProvider } from 'hiveagents-runtime';\n"
      + "import { createAntigravityCliProvider } from 'hiveagents-runtime';\n"
      + "import { readFile } from 'node:fs/promises';\nimport './runtime.js';")).not.toThrow();
    for (const source of ["import 'hiveagents-runtime/src/core/runtime.js'", "import '../../src/index.ts'",
      "await import('/tmp/checkout/src/index.ts')", "export * from 'hiveagents-runtime/adapter-kit/internal.js'",
      "const x = require('vitest')", "import 'file:///checkout/src/index.ts'",
      'await import(`hiveagents-runtime/src/index.js`)', 'await import(moduleName)']) {
      expect(() => verifier.auditSourceImports(source)).toThrow(/import/);
    }
  });

  it('rejects dependency directories, workspace links, aliases and implicit build tools', () => {
    expect(() => verifier.auditDependencySpecifications({ dependencies: {
      'hiveagents-runtime': 'file:vendor/core.tgz',
    }, devDependencies: { typescript: '5.9.3', '@types/node': '26.4.0' } })).not.toThrow();
    expect(() => verifier.auditDependencySpecifications({ dependencies: {
      'hiveagents-runtime-gemini-cli': 'file:vendor/adapter.tgz',
    } })).toThrow(/Forbidden dependencies dependency/);
    for (const spec of ['workspace:*', 'file:../..', 'link:../runtime', '/checkout', 'npm:other@1']) {
      expect(() => verifier.auditDependencySpecifications({ dependencies: { 'hiveagents-runtime': spec } })).toThrow(/dependency/);
    }
    expect(() => verifier.auditDependencySpecifications({ devDependencies: { vitest: '4.1.11' } })).toThrow(/dependency/);
  });

  it('rejects a symlink escaping the installed consumer while allowing npm bin links inside it', async () => {
    const consumer = await directory();
    const checkout = await directory();
    await mkdir(join(consumer, 'node_modules/typescript/bin'), { recursive: true });
    await mkdir(join(consumer, 'node_modules/.bin'));
    await writeFile(join(consumer, 'node_modules/typescript/bin/tsc'), 'fixture');
    await symlink('../typescript/bin/tsc', join(consumer, 'node_modules/.bin/tsc'));
    await expect(verifier.auditDependencyPaths(consumer, checkout)).resolves.toBeUndefined();
    await symlink(checkout, join(consumer, 'node_modules/hiveagents-runtime'));
    await expect(verifier.auditDependencyPaths(consumer, checkout)).rejects.toThrow(/outside|checkout/);
  });

  it('binds every generated application module rather than just its entry point', async () => {
    const consumer = await directory();
    await writeFile(join(consumer, 'package.json'), '{"type":"module"}');
    await mkdir(join(consumer, 'dist'));
    await writeFile(join(consumer, 'dist/main.js'), 'import "./session-send.js";');
    await writeFile(join(consumer, 'dist/session-send.js'), 'export const mode = "original";');
    const before = await verifier.hashApplicationCode(consumer);
    await writeFile(join(consumer, 'dist/session-send.js'), 'export const mode = "changed";');
    expect(await verifier.hashApplicationCode(consumer)).not.toBe(before);
    const afterCode = await verifier.hashApplicationCode(consumer);
    await writeFile(join(consumer, 'package.json'), '{"type":"commonjs"}');
    expect(await verifier.hashApplicationCode(consumer)).not.toBe(afterCode);
    await symlink(join(consumer, 'dist/main.js'), join(consumer, 'dist/linked.js'));
    await expect(verifier.hashApplicationCode(consumer)).rejects.toThrow(/symlink/i);
  });
});
