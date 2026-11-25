import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installedRuntimeBuilds } from './harness-identity.js';
import { validateTriageAuthority, type TriageAuthority } from './decision-triage.js';

export const HARNESS_VERSION = '1';
export async function harnessIdentity() {
  const hash = createHash('sha256');
  const files = (await readdir(new URL('.', import.meta.url), { withFileTypes: true })).filter(file => file.name.endsWith('.js')).sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    if (!file.isFile() || file.isSymbolicLink()) throw new TypeError('Harness build inputs must be regular files');
    hash.update(file.name); hash.update(await readFile(new URL(`./${file.name}`, import.meta.url)));
  }
  hash.update(JSON.stringify(await installedRuntimeBuilds()));
  return { id: 'document-triage-harness', version: HARNESS_VERSION, digest: hash.digest('hex') };
}
export async function stateDirectory(path: string): Promise<string> {
  const directory = resolve(path); await mkdir(directory, { recursive: true, mode: 0o700 }); return realpath(directory);
}
export function localAuthority(path: string): () => TriageAuthority {
  const file = resolve(path);
  return () => validateTriageAuthority(JSON.parse(readFileSync(file, 'utf8')));
}
export function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new TypeError('Expected a bounded positive integer');
  return parsed;
}
