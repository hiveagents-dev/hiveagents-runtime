/** Install exact SDK tarball into an ordinary, independent npm app. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyInstalledTarball } from './verify-package-contents.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applicationDependencies = new Set(['hiveagents-runtime']);
// The app fingerprints launch targets through the published resolver, without private SDK imports.
const publicPackages = new Set([...applicationDependencies, 'hiveagents-runtime/orchestration', 'hiveagents-runtime/orchestration/log', 'hiveagents-runtime/hosted', 'hiveagents-runtime/adapter-kit', 'hiveagents-runtime/routing', 'hiveagents-runtime/routing/learning']);
const applicationDevDependencies = new Set(['typescript', '@types/node']);
const hash = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => { const value = relative(parent, child); return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value)); };

export function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== '--core-tarball') throw new TypeError(`Unknown argument ${flag}`);
    if (values.has(flag)) throw new TypeError(`duplicate argument ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${flag}`);
    values.set(flag, resolve(value));
  }
  if (!values.has('--core-tarball')) throw new TypeError('Missing required --core-tarball');
  return { coreTarball: values.get('--core-tarball') };
}

export function auditSourceImports(source) {
  if (/\b(?:import|require)\s*\(\s*[^\s'"]/.test(source)) throw new Error('Computed imports are not supported by the consumer audit');
  const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) {
    const name = match[1];
    if (publicPackages.has(name) || name.startsWith('node:')
      || /^\.\/[^?\n]+\.js$/.test(name) && !name.split('/').includes('..')
      || /^\.\.\/dist\/[^?\n]+\.js$/.test(name) && !name.slice(3).split('/').includes('..')) continue;
    throw new Error(`Forbidden application import: ${name}`);
  }
}

export function auditDependencySpecifications(manifest) {
  for (const [field, allowed] of [['dependencies', applicationDependencies], ['devDependencies', applicationDevDependencies]]) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (!allowed.has(name) || typeof value !== 'string'
        || /^(?:workspace:|link:|npm:|\/|\.\.?\/|git|https?:)/.test(value)
        || value.startsWith('file:') && !/^file:(?!\/)[^\n]*\.(?:tgz|tar\.gz)$/.test(value)) {
        throw new Error(`Forbidden ${field} dependency ${name}: ${value}`);
      }
    }
  }
}

export async function auditDependencyPaths(consumer, checkout) {
  const allowedRoot = await realpath(consumer);
  const forbiddenRoot = await realpath(checkout);
  const visited = new Set();
  async function visit(path) {
    const canonical = await realpath(path);
    if (!within(allowedRoot, canonical) || within(forbiddenRoot, canonical)) {
      throw new Error(`Dependency resolves outside consumer or into checkout: ${path} -> ${canonical}`);
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || visited.has(canonical)) return;
    visited.add(canonical);
    for (const child of await readdir(path)) await visit(join(path, child));
  }
  await visit(join(consumer, 'node_modules'));
}

export async function hashApplicationCode(consumer) {
  const files = [['package.json', hash(await readFile(join(consumer, 'package.json')))]];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `Application output symlink: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else {
        assert.ok(entry.isFile(), `Application output is not a regular file: ${file}`);
        files.push([relative(consumer, file), hash(await readFile(file))]);
      }
    }
  }
  await visit(join(consumer, 'dist'));
  assert.ok(files.length, 'Application output is empty');
  return hash(JSON.stringify(files.sort(([left], [right]) => left.localeCompare(right))));
}

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', timeout: 360_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}

async function auditApplication(consumer) {
  const manifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'));
  auditDependencySpecifications(manifest);
  for (const name of applicationDependencies) assert.ok(manifest.dependencies?.[name], `App must declare ${name}`);
  for (const name of applicationDevDependencies) assert.ok(manifest.devDependencies?.[name], `App must own ${name}`);
  const config = JSON.parse(await readFile(join(consumer, 'tsconfig.json'), 'utf8'));
  assert.equal(config.compilerOptions.module, 'NodeNext');
  assert.equal(config.compilerOptions.moduleResolution, 'NodeNext');
  assert.equal(config.compilerOptions.skipLibCheck, false);
  assert.equal(config.compilerOptions.paths, undefined, 'No source path aliases');
  assert.equal(config.compilerOptions.baseUrl, undefined, 'No checkout resolution base');
  assert.equal(config.extends, undefined, 'Consumer owns its TypeScript configuration');
  async function sourceFiles(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `Source symlink: ${file}`);
      if (entry.isDirectory()) await sourceFiles(file);
      else if (/\.(?:ts|mjs)$/.test(file)) auditSourceImports(await readFile(file, 'utf8'));
    }
  }
  await sourceFiles(join(consumer, 'src'));
}

async function auditInstalled(consumer) {
  await auditDependencyPaths(consumer, root);
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  for (const name of applicationDependencies) {
    const instances = Object.keys(lock.packages).filter(path => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
    assert.deepEqual(instances, [`node_modules/${name}`], `Consumer must resolve a single installed ${name}`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    assert.notEqual(entry.link, true, `Linked dependency: ${path}`);
    if (entry.resolved?.startsWith('file:')) {
      assert.match(entry.resolved, /^file:vendor\/core\.tgz$/, `Directory or nonportable dependency: ${path}`);
    }
    assert.equal(/(?:^|\/)node_modules\/(?:vitest|tsup|esbuild|@anthropic-ai\/claude-agent-sdk|@modelcontextprotocol\/sdk)$/.test(path), false,
      `Unexpected development or optional peer dependency: ${path}`);
  }
  return JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { realpathSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    const names = ['hiveagents-runtime', 'hiveagents-runtime/orchestration', 'hiveagents-runtime/orchestration/log', 'hiveagents-runtime/routing', 'hiveagents-runtime/routing/learning'];
    const resolved = Object.fromEntries(names.map(name => [name, realpathSync(fileURLToPath(import.meta.resolve(name)))]));
    for (const name of names) await import(name);
    const { Runtime, createDefaultProviders, createGeminiCliProvider, createAntigravityCliProvider } = await import('hiveagents-runtime');
    assert.deepEqual(new Runtime().providers(), ['claude', 'codex', 'gemini', 'antigravity']);
    assert.deepEqual(createDefaultProviders().map(provider => provider.id), new Runtime().providers());
    assert.equal(createGeminiCliProvider().id, 'gemini');
    assert.equal(createAntigravityCliProvider().id, 'antigravity');
    await assert.rejects(import('hiveagents-runtime-gemini-cli'), error => error.code === 'ERR_MODULE_NOT_FOUND');
    await assert.rejects(import('hiveagents-runtime-antigravity-cli'), error => error.code === 'ERR_MODULE_NOT_FOUND');
    await assert.rejects(import('@anthropic-ai/claude-agent-sdk'), error => error.code === 'ERR_MODULE_NOT_FOUND');
    await assert.rejects(import('@modelcontextprotocol/sdk/types.js'), error => error.code === 'ERR_MODULE_NOT_FOUND');
    await assert.rejects(import('hiveagents-runtime/src/index.js'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    console.log(JSON.stringify(resolved));
  `], consumer));
}

export async function verifyExternalConsumer(options) {
  const { coreTarball } = options;
  assert.match(coreTarball, /\.(?:tgz|tar\.gz)$/);
  assert.ok((await stat(coreTarball)).isFile(), `Not a tarball file: ${coreTarball}`);
  const temporary = await mkdtemp(join(tmpdir(), 'oar-external-consumer-'));
  assert.equal(within(await realpath(root), await realpath(temporary)), false, 'Consumer must be outside checkout');
  const consumer = join(temporary, 'document-triage');
  try {
    await mkdir(consumer);
    for (const item of ['package.json', 'tsconfig.json', 'README.md', 'src', 'tests', 'config']) {
      await cp(join(root, 'apps/document-triage', item), join(consumer, item), { recursive: true });
    }
    const sourceLock = join(root, 'apps/document-triage/package-lock.json');
    await cp(sourceLock, join(consumer, 'package-lock.json'));
    await auditApplication(consumer);
    await mkdir(join(consumer, 'vendor'));
    await cp(coreTarball, join(consumer, 'vendor/core.tgz'), { dereference: true });
    run('npm', ['install', '--no-audit', '--no-fund', './vendor/core.tgz'], consumer);
    await auditApplication(consumer);
    const modules = await auditInstalled(consumer);
    verifyInstalledTarball(coreTarball, join(consumer, 'node_modules/hiveagents-runtime'));
    for (const path of Object.values(modules)) assert.ok(within(await realpath(consumer), path), `Module escaped consumer: ${path}`);
    run('npm', ['run', 'typecheck'], consumer);
    run('npm', ['run', 'build'], consumer);
    const tests = run('npm', ['test'], consumer);
    // A separate, model-free doctor invocation uses the fake installed support.
    const environment = { ...process.env, GEMINI_API_KEY: 'fixture-not-a-credential',
      OAR_GEMINI_COMMAND: process.execPath,
      OAR_GEMINI_ARGS_JSON: JSON.stringify([join(consumer, 'tests/fixtures/fake-gemini.mjs')]),
      OAR_ANTIGRAVITY_COMMAND: process.execPath,
      OAR_ANTIGRAVITY_ARGS_JSON: JSON.stringify([join(consumer, 'tests/fixtures/fake-antigravity.mjs')]) };
    const doctor = JSON.parse(run(process.execPath, ['dist/main.js', 'doctor'], consumer, environment));
    assert.ok(doctor.providers.some(provider => provider.provider === 'gemini' && provider.installation.installed));
    assert.ok(doctor.providers.some(provider => provider.provider === 'antigravity' && provider.installation.installed));
    const receipt = {
      kind: 'npm-installed-external-consumer', passed: true,
      node: process.version, platform: process.platform, architecture: process.arch,
      core: { sha256: hash(await readFile(coreTarball)) },
      lockSha256: hash(await readFile(join(consumer, 'package-lock.json'))),
      applicationCodeSha256: await hashApplicationCode(consumer),
      moduleResolution: modules, checks: ['npm-install', 'public-imports', 'realpaths', 'no-directory-deps',
        'bundled-providers', 'optional-peer-absent', 'NodeNext-types', 'build', 'fake-subprocess-tests', 'doctor'],
      modelTurns: 0, tests: tests.trim(),
      ...(process.env.OAR_CONSUMER_KEEP === '1' ? { consumerDirectory: consumer } : {}),
    };
    return receipt;
  } finally {
    if (process.env.OAR_CONSUMER_KEEP !== '1') await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await verifyExternalConsumer(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
