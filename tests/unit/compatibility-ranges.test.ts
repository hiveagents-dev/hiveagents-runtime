import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildCodexExecArgs } from '../../src/adapters/codex/exec-adapter.js';
import {
  COMPATIBILITY_MANIFEST,
  assessCliCompatibility,
  findCompatibilityEntry,
  validateCompatibilityManifest,
  type CompatibilityEntry,
} from '../../src/compatibility/manifest.js';
import {
  parseCliVersion,
  parseCliVersionRange,
  rangeIncludes,
} from '../../src/compatibility/version-range.js';
import { translateContext } from '../../src/core/context.js';
import { translatePermissions } from '../../src/core/permissions.js';

/** `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex exec fork --help` from codex-cli 0.153.4. */
const help = (name: string) => readFileSync(new URL(`../fixtures/codex/help-0.153.4/${name}.txt`, import.meta.url), 'utf8');
const codexHelp = { top: help('codex'), main: help('exec'), resume: help('exec-resume'), fork: help('exec-fork') };

function entry(cliRange: string, overrides: Partial<CompatibilityEntry> = {}): CompatibilityEntry {
  return { provider: 'codex', cliRange, transport: 'exec', evidence: 'live-contract', features: {}, knownIssues: [], ...overrides };
}

describe('compatibility version grammar', () => {
  it('parses plain release versions only', () => {
    expect(parseCliVersion('0.153.4')).toEqual([0, 153, 4]);
    expect(parseCliVersion('2.1.228')).toEqual([2, 1, 228]);
    for (const text of ['0.153.4-alpha.1', '0.153.4+build.7', 'v0.153.4', ' 0.153.4', '0.153.4 ', '0.153', '0.153.4.1',
      '00.153.4', '0.0153.4', '0.153.04', '', 'codex-cli 0.153.4', '0.153.x']) {
      expect(parseCliVersion(text), text).toBeUndefined();
    }
  });

  it('parses exact versions and half-open intervals', () => {
    expect(parseCliVersionRange('2.1.228')).toMatchObject({ kind: 'exact', low: [2, 1, 228], high: [2, 1, 228] });
    expect(parseCliVersionRange('>=0.153.4 <0.154.0')).toMatchObject({ kind: 'interval', low: [0, 153, 4], high: [0, 154, 0] });
  });

  it('rejects malformed, prerelease and empty ranges deterministically', () => {
    for (const range of ['', '>=0.153.4', '<0.154.0', '>0.153.4 <0.154.0', '>=0.153.4 <=0.154.0', '>= 0.153.4 <0.154.0',
      '>=0.153.4  <0.154.0', '<0.154.0 >=0.153.4', '>=0.153.4-alpha.1 <0.154.0', '>=0.153.4 <0.154.0-rc.1', '0.153.4-beta',
      '^0.153.4', '~0.153.4', '0.153.x', '*', '0.153.4 || 0.154.0', '>=0.154.0 <0.154.0', '>=0.154.0 <0.153.4']) {
      expect(() => parseCliVersionRange(range), range).toThrow(TypeError);
    }
  });

  it('includes the lower bound and excludes the upper bound', () => {
    const range = parseCliVersionRange('>=0.153.4 <0.154.0');
    const at = (text: string) => rangeIncludes(range, parseCliVersion(text)!);
    expect(at('0.153.3')).toBe(false);
    expect(at('0.153.4')).toBe(true);
    expect(at('0.153.99')).toBe(true);
    expect(at('0.154.0')).toBe(false);
    expect(at('1.153.4')).toBe(false);
    const exact = parseCliVersionRange('2.1.228');
    expect(rangeIncludes(exact, [2, 1, 228])).toBe(true);
    expect(rangeIncludes(exact, [2, 1, 229])).toBe(false);
  });
});

describe('compatibility manifest structure', () => {
  it('ships a manifest without overlaps, malformed ranges or help-probe claims of support', () => {
    expect(() => validateCompatibilityManifest(COMPATIBILITY_MANIFEST)).not.toThrow();
  });

  it('treats overlapping ranges for one provider and transport as a programming error', () => {
    expect(() => validateCompatibilityManifest([entry('>=0.150.0 <0.154.0'), entry('>=0.153.0 <0.155.0')])).toThrow(/overlap/);
    expect(() => validateCompatibilityManifest([entry('0.149.0'), entry('0.149.0')])).toThrow(/overlap/);
    expect(() => validateCompatibilityManifest([entry('>=0.150.0 <0.153.0'), entry('bad')])).toThrow(TypeError);
  });

  it('allows adjacent intervals, an exact version inside an interval, and other providers or transports', () => {
    expect(() => validateCompatibilityManifest([
      entry('>=0.150.0 <0.153.0'),
      entry('>=0.153.0 <0.154.0'),
      entry('0.153.4'),
      entry('>=0.150.0 <0.154.0', { provider: 'claude' }),
      entry('>=0.150.0 <0.154.0', { transport: 'control' }),
    ])).not.toThrow();
  });

  it('refuses an entry that turns help-probe evidence into supported', () => {
    expect(() => validateCompatibilityManifest([entry('0.153.4', { evidence: 'help-probe', features: { resume: 'supported' } })]))
      .toThrow(/declares supported: resume/);
  });

  it('prefers an exact entry over the interval that contains it and fails on ambiguity', () => {
    const exact = entry('0.153.4', { knownIssues: ['exact'] });
    const interval = entry('>=0.153.0 <0.154.0', { knownIssues: ['interval'] });
    expect(findCompatibilityEntry('codex', 'exec', '0.153.4', [interval, exact])).toBe(exact);
    expect(findCompatibilityEntry('codex', 'exec', '0.153.5', [interval, exact])).toBe(interval);
    expect(() => findCompatibilityEntry('codex', 'exec', '0.153.5', [interval, entry('>=0.153.5 <0.153.6')]))
      .toThrow(/ambiguous/);
  });
});

describe('codex-cli 0.153.x coverage', () => {
  it('resolves 0.153.4 and later 0.153 patches to the help-probe entry, nothing else', () => {
    const resolved = findCompatibilityEntry('codex', 'exec', '0.153.4');
    expect(resolved).toMatchObject({ cliRange: '>=0.153.4 <0.154.0', evidence: 'help-probe' });
    expect(findCompatibilityEntry('codex', 'exec', '0.153.12')).toBe(resolved);
    for (const version of ['0.153.3', '0.154.0', '0.150.0', '0.153.5-alpha.1', 'unknown']) {
      expect(findCompatibilityEntry('codex', 'exec', version), version).toBeUndefined();
    }
    expect(findCompatibilityEntry('codex', 'exec', '0.149.0')).toMatchObject({ evidence: 'live-contract' });
    expect(findCompatibilityEntry('codex', 'control', '0.153.4')).toBeUndefined();
    expect(findCompatibilityEntry('claude', 'exec', '2.1.228')).toMatchObject({ cliRange: '2.1.228', evidence: 'live-contract' });
  });

  it('assesses the captured 0.153.4 help as help-probe evidence that never claims support', () => {
    const assessment = assessCliCompatibility('codex', '0.153.4', codexHelp);
    expect(assessment.evidence).toBe('help-probe');
    expect(assessment.missingFlags).toEqual([]);
    for (const feature of ['turns', 'resume', 'forkWithPrompt', 'structuredOutput', 'permissions']) {
      expect(assessment.features[feature], feature).toBe('unverified');
    }
    expect(assessment.features.cleanContext).toBe('partial');
    expect(assessment.features.tokenDeltas).toBe('unsupported');
    expect(assessment.features.forkWithoutPrompt).toBe('unsupported');
    expect(Object.values(assessment.features)).not.toContain('supported');
    expect(assessment.knownIssues).toContain('Help-probed only: no live contract turn backs this range');

    const without = assessCliCompatibility('codex', '0.153.4', { ...codexHelp, main: codexHelp.main.replace('--output-schema', '--other') });
    expect(without.features.structuredOutput).toBe('unsupported');
    expect(without.missingFlags).toEqual(['--output-schema']);
  });

  it('keeps unknown versions on the degraded path exactly as before', () => {
    const assessment = assessCliCompatibility('codex', '0.153.3', codexHelp);
    expect(assessment.evidence).toBe('help-probe');
    expect(assessment.features.cleanContext).toBe('unverified');
    expect(assessment.knownIssues).toEqual(['CLI version is outside the exact tested manifest']);
  });

  it('finds every flag the exec adapter emits defined where the adapter places it', () => {
    const defined = (text: string, flag: string) => text.split('\n').some((line) =>
      /^\s*-/.test(line) && (line.trimStart().split(/ {2,}|\t/)[0] ?? '').split(/[\s,[=]/).includes(flag));
    const permissions = ['analyze', 'edit', 'unrestricted'].flatMap((mode) =>
      translatePermissions('codex', { mode: mode as 'analyze', additionalDirectories: ['/tmp/x'] }, 'exec').args);
    const context = ['project', 'clean'].flatMap((profile) =>
      translateContext('codex', { profile: profile as 'clean', memory: 'off' }).args);
    for (const [mode, surface] of [['open', codexHelp.main], ['resume', codexHelp.resume], ['fork', codexHelp.fork]] as const) {
      const args = buildCodexExecArgs({
        mode, modelId: 'gpt-5.6-sol', cwd: '/tmp/repo', prompt: 'hi', env: {}, contextArgs: context,
        permissionArgs: permissions, timeoutMs: 1, maxOutputBytes: 1, effort: 'high', requireSubscription: true,
        ...(mode === 'open' ? { instructions: 'be brief' } : { sessionId: 'abc' }),
        providerOptions: { config: { a: 1 }, ignoreUserConfig: true, ignoreRules: true, ephemeral: true, skipGitRepoCheck: true },
      }, '/tmp/schema.json');
      const split = args.indexOf('exec');
      const flags = (part: string[]) => part.filter((arg) => arg.startsWith('--'));
      for (const flag of flags(args.slice(0, split))) expect(defined(codexHelp.top, flag), `top ${flag}`).toBe(true);
      for (const flag of flags(args.slice(split + 1))) expect(defined(surface, flag), `${mode} ${flag}`).toBe(true);
    }
    expect(defined(codexHelp.main, '--ask-for-approval')).toBe(false);
  });
});
