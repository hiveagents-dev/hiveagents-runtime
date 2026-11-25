import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Agent, Runtime, createClaudeControlRegistration, createCodexControlRegistration } from '../../src/index.js';
import { AsyncQueue } from '../../src/adapters/claude-control/async-queue.js';
import { loadClaudeAgentSdk, type SdkUserMessage } from '../../src/adapters/claude-control/sdk.js';
import { buildEnvironment } from '../../src/core/environment.js';
import type { ProviderId } from '../../src/public/types.js';

const enabled = process.env.OAR_LIVE === '1';
const turns = enabled && process.env.OAR_LIVE_TURNS === '1';
const providers = (['claude', 'codex'] as const).filter((provider) =>
  !process.env.OAR_LIVE_PROVIDER || process.env.OAR_LIVE_PROVIDER === provider);

function agent(provider: ProviderId, cwd: string) {
  return new Agent({
    model: provider === 'claude' ? 'opus-5' : 'gpt-5.6-sol', cwd, transport: 'control',
    environment: { mode: 'minimal' }, requireAuth: 'subscription',
    context: provider === 'claude' ? { profile: 'clean', memory: 'off' } : { profile: 'native', memory: 'off' },
    permissions: { mode: 'analyze' },
    instructions: 'Do not use tools. Answer only the requested short marker.',
    providerOptions: { experimentalControl: true },
  }, new Runtime({ controlAdapters: [createClaudeControlRegistration(), createCodexControlRegistration()] }));
}

describe.runIf(enabled).sequential.each(providers)('%s live control', (provider) => {
  it('initializes and closes the real transport without a model turn', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'oar-control-handshake-')));
    try {
      const runtimeAgent = agent(provider, cwd);
      const readiness = await runtimeAgent.ready();
      expect(readiness.auth.source).toBe('subscription');
      if (provider === 'codex') {
        const session = await runtimeAgent.openSession({ persistence: 'process' });
        try { expect(session.identity?.id).toBeTruthy(); } finally { await session.close(); }
      } else {
        // Query is lazy in the public factory. This probe isolates the SDK handshake.
        const sdk = await loadClaudeAgentSdk();
        const input = new AsyncQueue<SdkUserMessage>();
        const query = sdk.query({ prompt: input, options: {
          cwd, env: buildEnvironment({ mode: 'minimal' }), persistSession: false,
          pathToClaudeCodeExecutable: readiness.plan.fingerprint.executableRealpath,
          permissionMode: 'plan', extraArgs: { 'safe-mode': null },
        } });
        try {
          const initialize = (query as unknown as { initializationResult(): Promise<unknown> }).initializationResult;
          expect(typeof initialize).toBe('function');
          await initialize.call(query);
        } finally { input.end(); query.close?.(); }
      }
      console.info(`[control:${provider}] handshake cli=${readiness.installation.version} auth=subscription`);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 60_000);

  it.runIf(turns)('keeps two minimal turns in one process session and closes it', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'oar-control-turns-')));
    try {
      const session = await agent(provider, cwd).openSession({ persistence: 'process' });
      try {
        const first = await session.send('Reply exactly OAR_CONTROL_FIRST_OK.', { timeoutMs: 90_000 });
        expect(first.text).toContain('OAR_CONTROL_FIRST_OK');
        const second = await session.send('Reply exactly OAR_CONTROL_SECOND_OK.', { timeoutMs: 90_000 });
        expect(second.text).toContain('OAR_CONTROL_SECOND_OK');
        expect(second.session.id).toBe(first.session.id);
        expect(() => session.export()).toThrow();
      } finally { await session.close(); }
      expect(session.state).toBe('closed');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 200_000);
});
