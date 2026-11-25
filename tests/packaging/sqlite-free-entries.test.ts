import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Needs the built package (`npm run build`). Each entry is imported in a fresh `node` so the
// probe sees only what that import loaded: `process.moduleLoadList` names every builtin binding.
function load(entry: string): { sqlite: string[]; stderr: string } {
  const path = resolve('dist', entry);
  if (!existsSync(path)) throw new Error(`${path} is missing; run npm run build first`);
  const probe = `await import(${JSON.stringify(pathToFileURL(path).href)});
process.stdout.write(JSON.stringify(process.moduleLoadList.filter((name) => /sqlite/i.test(name))));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  expect(child.status, child.stderr).toBe(0);
  return { sqlite: JSON.parse(child.stdout) as string[], stderr: child.stderr };
}

describe('entries that must not load node:sqlite', () => {
  // routing/index covers the fixed/auto selector, whose WorkflowStore is file based.
  // memory-tools reaches memory only through the application's provider.
  // orchestration/dynamic journals to JSONL files and loads the Agent class only on first use.
  for (const entry of ['index.js', 'adapter-kit.js', 'hosted-runtime.js', 'routing/index.js', 'memory-tools.js', 'orchestration/dynamic.js']) {
    it(`importing dist/${entry} loads no SQLite and prints no SQLite warning`, () => {
      const { sqlite, stderr } = load(entry);
      expect(sqlite).toEqual([]);
      expect(stderr).not.toMatch(/SQLite/i);
    });
  }

  it('the probe does see node:sqlite when an SQLite-backed entry loads it', () => {
    expect(load('orchestration/index.js').sqlite.length).toBeGreaterThan(0);
  });
});
