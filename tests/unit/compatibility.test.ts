import { describe, expect, it } from 'vitest';

import { assessCliCompatibility } from '../../src/index.js';

describe('CLI compatibility assessment', () => {
  it('keeps manifest evidence only when every required flag is observed', () => {
    const assessment = assessCliCompatibility('claude', '2.1.251', {
      main: '--print --output-format --model --session-id --verbose --resume --fork-session --json-schema --include-partial-messages --safe-mode --permission-mode',
    });

    expect(assessment.evidence).toBe('live-contract');
    expect(assessment.features.turns).toBe('supported');
    expect(assessment.features.tokenDeltas).toBe('supported');
    // Fork is split in two: the with-prompt form is live-verified on this CLI,
    // the promptless form is not a supported exec semantic on any tested build.
    expect(assessment.features.forkWithPrompt).toBe('supported');
    expect(assessment.features.forkWithoutPrompt).toBe('unsupported');
    expect(assessment.missingFlags).toEqual([]);
  });

  it('marks a feature unsupported when its installed CLI flag is absent', () => {
    const assessment = assessCliCompatibility('claude', '2.1.251', {
      main: '--print --output-format --model --session-id --verbose --resume --json-schema --safe-mode --permission-mode',
    });

    expect(assessment.features.forkWithPrompt).toBe('unsupported');
    expect(assessment.features.tokenDeltas).toBe('unsupported');
    expect(assessment.missingFlags).toEqual(expect.arrayContaining([
      '--fork-session',
      '--include-partial-messages',
    ]));
  });

  it('treats an unknown but flag-compatible version as help-probed, never live-tested', () => {
    const assessment = assessCliCompatibility('codex', '0.150.0', {
      main: '--json --model --output-schema --ignore-user-config --ignore-rules --sandbox',
      resume: '--json --model --output-schema --ignore-user-config --ignore-rules',
      fork: '--json --model --output-schema --ignore-user-config --ignore-rules',
    });

    expect(assessment.evidence).toBe('help-probe');
    expect(assessment.features.turns).toBe('unverified');
    expect(assessment.features.resume).toBe('unverified');
  });

  it('counts a flag only where an option line defines it, never in descriptive text', () => {
    const help = [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Options:',
      '  -p, --print                       Print response and exit (pair it with --resume to continue)',
      '  --output-format <format>          Output format',
      '  --model <model>                   Model for the session',
      '  --session-id <uuid>               Use a specific session ID',
      '  --verbose                         Override verbose mode',
      '  --json-schema <schema>            JSON Schema for structured output',
      '  --include-partial-messages        Include partial message chunks; implies --fork-session behaviour',
      '  --safe-mode                       Skip user configuration',
      '  --permission-mode <mode>          Permission mode (choices: "default", "dontAsk")',
      '  -c, --continue                    Continue the most recent conversation; see also --resume',
      '',
      'Use --resume <id> or --fork-session to branch an existing session.',
    ].join('\n');
    const assessment = assessCliCompatibility('claude', '2.1.251', { main: help });
    expect(assessment.missingFlags).toEqual(['--resume', '--fork-session']);
    expect(assessment.features.resume).toBe('unsupported');
    expect(assessment.features.forkWithPrompt).toBe('unsupported');
    expect(assessment.features.turns).toBe('supported');
    expect(assessment.features.permissions).toBe('supported');

    const defined = assessCliCompatibility('claude', '2.1.251', {
      main: `${help}\n  -r, --resume [value]              Resume a conversation\n  --fork-session=<bool>             Fork when resuming`,
    });
    expect(defined.missingFlags).toEqual([]);
    expect(defined.features.resume).toBe('supported');
  });
});
