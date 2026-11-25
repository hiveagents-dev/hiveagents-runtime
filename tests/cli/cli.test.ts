import { describe, expect, it } from 'vitest';

import { Runtime, runCli, type ExecAdapter, type ExecTurnRequest } from '../../src/index.js';

class CliAdapter implements ExecAdapter {
  readonly id = 'claude' as const;
  async detect() { return { installed: true, path: '/bin/claude', version: '1.0.0' }; }
  async auth() { return { authenticated: true, source: 'subscription' as const }; }
  async models() { return []; }
  async execute(request: ExecTurnRequest) {
    return {
      completed: true,
      failed: false,
      refused: false,
      sessionId: 'cli-session',
      text: `answer:${request.prompt}`,
      events: [],
      nativeEvents: [],
    };
  }
}

function io() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe('npx CLI', () => {
  it('runs a one-shot turn through the SDK', async () => {
    const output = io();
    const code = await runCli(
      ['run', '--model', 'opus-5', 'hello'],
      output.io,
      new Runtime({ adapters: [new CliAdapter()] }),
    );

    expect(code).toBe(0);
    expect(output.output().stdout).toContain('answer:hello');
  });

  it('returns usage errors without launching a provider', async () => {
    const output = io();
    const code = await runCli(['run', 'hello'], output.io, new Runtime({ adapters: [] }));

    expect(code).toBe(2);
    expect(output.output().stderr).toContain('--model');
  });

  it('keeps only fixed diagnostic fields in a versioned share report', async () => {
    const privateData = 'HOST_DIAGNOSTIC_CANARY';
    class PrivateAdapter extends CliAdapter {
      override async detect() {
        return {
          installed: true, path: '/private/' + privateData, realpath: '/real/' + privateData,
          identityFiles: ['/identity/' + privateData], launchTarget: { command: '/launch/' + privateData, argsPrefix: [privateData] },
          version: '1.2.3',
        };
      }
      override async auth() {
        return { authenticated: true, source: 'subscription' as const, account: { plan: privateData } };
      }
      async compatibility() {
        return {
          provider: 'claude', cliVersion: '1.2.3', transport: 'exec' as const, evidence: 'help-probe' as const,
          features: { turns: 'supported' as const }, missingFlags: [privateData], knownIssues: [privateData],
        };
      }
      override async execute(): Promise<never> { throw new Error('doctor executed a turn'); }
    }
    const runtime = new Runtime({ adapters: [new PrivateAdapter()] });
    const ordinary = io();
    expect(await runCli(['doctor'], ordinary.io, runtime)).toBe(0);
    expect(ordinary.output().stdout).toContain(privateData);

    const shared = io();
    expect(await runCli(['doctor', '--share'], shared.io, runtime)).toBe(0);
    expect(shared.output()).toMatchObject({ stderr: '' });
    expect(shared.output().stdout).not.toContain(privateData);
    expect(JSON.parse(shared.output().stdout)).toEqual({
      format: 1,
      runtime: { platform: process.platform, arch: process.arch, node: process.versions.node },
      providers: [{
        provider: 'claude',
        installation: { installed: true, version: '1.2.3' },
        auth: { state: 'authenticated', source: 'subscription' },
        transports: [{ kind: 'exec', available: true }, { kind: 'control', available: false }],
        warningCodes: ['CLI_FLAGS_MISSING'],
      }],
    });
  });

  it('omits arbitrary prose from the CLI version field', async () => {
    class UnstructuredVersion extends CliAdapter {
      override async detect() {
        return { installed: true, path: '/bin/claude', version: '1.2.3 HOST_VERSION_CANARY' };
      }
    }
    const shared = io();
    expect(await runCli(['doctor', '--share'], shared.io, new Runtime({ adapters: [new UnstructuredVersion()] }))).toBe(0);
    const output = shared.output();
    expect(output.stdout).not.toContain('HOST_VERSION_CANARY');
    expect(JSON.parse(output.stdout).providers[0].installation).toEqual({ installed: true });
  });

  it('does not print diagnostic exceptions in share mode', async () => {
    class FailingProbe extends CliAdapter {
      override async detect(): Promise<never> { throw new Error('HOST_DIAGNOSTIC_CANARY'); }
    }
    const shared = io();
    expect(await runCli(['doctor', '--share'], shared.io, new Runtime({ adapters: [new FailingProbe()] }))).toBe(1);
    expect(shared.output()).toEqual({ stdout: '', stderr: 'Unable to generate the shareable diagnostic report.\n' });
  });

  it('never lets an option swallow another flag, rejects unknown flags and honours --', async () => {
    const turns: string[] = [];
    class Recording extends CliAdapter {
      override async execute(request: ExecTurnRequest) { turns.push(request.prompt); return super.execute(request); }
    }
    const runtime = () => new Runtime({ adapters: [new Recording()] });
    const rejected: Array<[string[], RegExp]> = [
      [['run', '--model', '--foo', 'hello'], /--model requires a value/],
      [['run', '--model'], /--model requires a value/],
      [['run', '--model', 'opus-5', '--temperature', '1', 'hello'], /Unknown option --temperature/],
      [['run', '--model', 'opus-5', '-x', 'hello'], /Unknown option -x/],
      [['run', '--model', 'opus-5', '--model', 'sonnet', 'hello'], /--model given more than once/],
      [['capabilities', '--model', '--verbose'], /--model requires a value/],
      [['doctor', '--json'], /Unknown option --json/],
      [['doctor', '--share=true'], /--share does not take a value/],
      [['doctor', '--share', '--share'], /--share given more than once/],
    ];
    for (const [args, message] of rejected) {
      const output = io();
      expect(await runCli(args, output.io, runtime())).toBe(2);
      expect(output.output().stderr).toMatch(message);
    }
    expect(turns).toEqual([]);

    const dashed = io();
    expect(await runCli(['run', '--model=opus-5', '--', '--not-a-flag', 'and', '--model', 'text'], dashed.io, runtime())).toBe(0);
    expect(dashed.output().stdout).toContain('answer:--not-a-flag and --model text');
    const after = io();
    expect(await runCli(['run', 'hello', '--model', 'opus-5', 'world'], after.io, runtime())).toBe(0);
    expect(turns).toEqual(['--not-a-flag and --model text', 'hello world']);
  });
});
