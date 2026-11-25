import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const enabled = process.env.OAR_LIVE === '1'
  && process.env.OAR_LIVE_TURNS === '1'
  && !!process.env.OAR_GEMINI_EXTERNAL_APP
  && !!process.env.OAR_GEMINI_MODEL;

describe.skipIf(!enabled)('installed Gemini through the independently installed application', () => {
  it('sends, resumes, checks its read-only canary and classifies with at most four launches', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/verify-gemini-live.mjs', import.meta.url))], {
      env: process.env, encoding: 'utf8', timeout: 420_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.passed).toBe(true);
    expect(receipt.launched).toBeLessThanOrEqual(4);
    expect(receipt.checks).toEqual(expect.arrayContaining([
      'first-turn', 'cross-process-native-resume', 'write-canary-absent', 'independent-app-classify-one',
    ]));
  }, 430_000);
});
