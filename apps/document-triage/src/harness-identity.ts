import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchTarget, Runtime } from 'hiveagents-runtime';
import { resolveBinaryCandidates } from 'hiveagents-runtime/adapter-kit';
import { appRuntimeLaunchTarget } from './runtime.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fileDigest(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

/** Read installed runtime bytes reached through a public package entry, including runtime chunks. */
export async function runtimePackageBuildDigest(entry: string): Promise<string> {
  const directory = dirname(await realpath(fileURLToPath(entry))), digest = createHash('sha256');
  const visit = async (path: string, prefix: string): Promise<void> => {
    for (const file of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (file.isSymbolicLink()) throw new TypeError('Runtime build inputs must be regular files');
      const relative = `${prefix}${file.name}`, absolute = join(path, file.name);
      if (file.isDirectory()) await visit(absolute, `${relative}/`);
      else if (file.name.endsWith('.js')) { if (!file.isFile()) throw new TypeError('Invalid runtime build input'); digest.update(relative); digest.update(await fileDigest(absolute)); }
    }
  };
  await visit(directory, ''); return digest.digest('hex');
}

export async function installedRuntimeBuilds(): Promise<{ name: string; digest: string }[]> {
  return Promise.all(['hiveagents-runtime']
    .map(async name => ({ name, digest: await runtimePackageBuildDigest(import.meta.resolve(name)) })));
}

async function targetIdentity(target: LaunchTarget, cwd: string) {
  const argsDigest = hash(JSON.stringify(target.argsPrefix));
  try {
    const command = await realpath(target.command), commandDigest = await fileDigest(command);
    const scripts: { index: number; pathDigest: string; digest: string }[] = [];
    for (const [index, argument] of target.argsPrefix.entries()) {
      // Arguments themselves are hashed; only positional script files are read, never auth stores or env values.
      if (argument.startsWith('-') || !['.js', '.mjs', '.cjs', '.ts', '.sh', '.py'].includes(extname(argument))) continue;
      const path = await realpath(isAbsolute(argument) ? argument : resolve(cwd, argument)).catch(() => undefined);
      if (path && (await stat(path)).isFile()) scripts.push({ index, pathDigest: hash(path), digest: await fileDigest(path) });
    }
    return { status: 'fingerprinted', commandPathDigest: hash(command), commandDigest, argsDigest, scripts };
  } catch { return { status: 'unavailable', commandPathDigest: hash(target.command), argsDigest }; }
}

/** Configuration identity, without native probes, credential reads, or claims about authenticated outcomes. */
export async function executionIdentity(runtime: Runtime, model: { provider: string; id: string }, cwd: string) {
  const configuration = appRuntimeLaunchTarget(runtime, model.provider), canonicalCwd = await realpath(cwd);
  const policy = { provider: model.provider, model: model.id, cwdDigest: hash(canonicalCwd), context: 'native', requireAuth: 'any',
    permissions: model.provider === 'antigravity' ? 'edit' : 'analyze', transport: 'exec', awaitSettlement: true };
  if (!configuration.known) return { attestation: 'custom-runtime-unattested', digest: hash(JSON.stringify({ ...policy, nonce: randomUUID() })) };
  const name = model.provider === 'antigravity' ? 'agy' : model.provider;
  const targets = configuration.target ? [configuration.target] : resolveBinaryCandidates(name);
  const launch = { selection: configuration.target ? 'configured' : 'unprobed-path-candidates',
    targets: await Promise.all(targets.map(target => targetIdentity(target, canonicalCwd))) };
  return { attestation: 'configuration-only', digest: hash(JSON.stringify({ ...policy, launch })) };
}
