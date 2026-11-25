import { describe, expect, it } from 'vitest';
import type { AuthStatus, ExecAdapter, ExecTurnRequest } from '../../src/index.js';
import { SubscriptionExecAdapter } from '../../src/core/subscription-exec.js';
import { assertRespondAuth } from '../../src/core/respond-policy.js';

const request: ExecTurnRequest = { mode: 'open', modelId: 'fixture', cwd: process.cwd(), prompt: 'hello', env: {}, contextArgs: [], permissionArgs: [], timeoutMs: 1000, maxOutputBytes: 1000 };

describe('confirmed subscription evidence across reused turns', () => {
  for (const drift of [
    { authenticated: true, source: 'subscription', state: 'unknown' },
    { authenticated: true, source: 'subscription', state: 'not-authenticated' },
    { authenticated: true, source: 'subscription', evidence: 'local-configuration' },
  ] as AuthStatus[]) {
    for (const streaming of [false, true]) {
      it(`refuses ${JSON.stringify(drift)} for ${streaming ? 'stream' : 'execute'}`, async () => {
        let auth: AuthStatus = { authenticated: true, source: 'subscription' };
        let calls = 0;
        const success = { completed: true, failed: false, refused: false, text: 'ok', events: [], nativeEvents: [] };
        const inner: ExecAdapter = {
          id: 'claude', detect: async () => ({ installed: true }), auth: async () => auth, models: async () => [],
          execute: async () => { calls++; return success; },
          stream: async function* () { calls++; yield { kind: 'result', result: success }; },
        };
        const adapter = new SubscriptionExecAdapter(inner);
        const dispatch = async () => {
          if (!streaming) return adapter.execute(request);
          for await (const _item of adapter.stream!(request)) { /* consume */ }
        };
        await dispatch();
        auth = drift;
        await expect(dispatch()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
        expect(calls).toBe(1);
        expect(() => assertRespondAuth({ model: 'opus', requireAuth: 'subscription' }, drift)).toThrow();
      });
    }
  }
});
