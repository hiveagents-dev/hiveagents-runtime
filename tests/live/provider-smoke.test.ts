import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { AbortError, Agent, UnsupportedCapabilityError } from '../../src/index.js';
import { runProcess } from '../../src/process/run-process.js';
import type { AgentOptions, ProviderId, SessionRef } from '../../src/index.js';

const enabled = process.env.OAR_LIVE === '1';
const turnIt = it.runIf(process.env.OAR_LIVE_TURNS === '1');
const selected = process.env.OAR_LIVE_PROVIDER;
const resumeChild = fileURLToPath(new URL('./resume-child.mjs', import.meta.url));

const cases: Array<{ provider: ProviderId; options: AgentOptions }> = [
  {
    provider: 'claude',
    options: {
      model: 'opus-5',
      context: { profile: 'clean', memory: 'off' },
      permissions: { mode: 'analyze' },
      requireAuth: 'subscription',
    },
  },
  {
    provider: 'codex',
    options: {
      model: 'gpt-5.6-sol',
      context: { profile: 'clean', memory: 'off' },
      permissions: { mode: 'analyze', strict: false },
      requireAuth: 'subscription',
    },
  },
];

describe.runIf(enabled).sequential.each(cases.filter(({ provider }) => !selected || selected === provider))(
  '$provider live exec contract',
  ({ provider, options }) => {
    let ref: SessionRef;

    turnIt('confirms first turn, native resume, and cross-Agent export/resume', async () => {
      const agent = new Agent(options);
      const session = await agent.openSession();
      expect(session.ref).toBeUndefined();

      const first = await session.send('Reply with exactly OAR_FIRST_OK and nothing else.');
      expect(first.text).toContain('OAR_FIRST_OK');
      expect(session.ref).toBeDefined();

      const resumed = await session.send('Reply with exactly OAR_RESUME_OK and nothing else.');
      expect(resumed.text).toContain('OAR_RESUME_OK');
      ref = session.export();

      const child = await runProcess({
        command: process.execPath,
        args: [resumeChild],
        cwd: process.cwd(),
        env: process.env,
        stdin: JSON.stringify({
          options,
          ref,
          prompt: 'Reply with exactly OAR_EXPORT_OK and nothing else.',
        }),
        timeoutMs: 300_000,
        maxOutputBytes: 1024 * 1024,
      });
      expect(child.code).toBe(0);
      const crossProcess = JSON.parse(child.stdout) as { text: string; sessionId: string };
      expect(crossProcess.text).toContain('OAR_EXPORT_OK');
      expect(crossProcess.sessionId).toBe(ref.id);
    }, 360_000);

    turnIt('forks with a prompt and confirms a distinct native child session', async () => {
      // Verificado en vivo contra claude 2.1.251 (`--resume <id> --fork-session`)
      // y codex 0.149.0 (`exec fork <id> <prompt>`): ambos confirman un id nuevo
      // conservando el contexto. El fork SIN prompt es la capability que ninguno
      // de los dos exec CLIs soporta, y se verifica aparte.
      const source = await new Agent(options).openSession({ resume: ref });
      const fork = await source.forkAndSend('Reply with exactly OAR_FORK_OK.');

      expect(fork.session.ref?.id).toBeDefined();
      expect(fork.session.ref?.id).not.toBe(ref.id);
      expect(fork.turn.status).toBe('completed');
    }, 180_000);

    turnIt('rejects promptless fork on exec, which neither CLI supports', async () => {
      const source = await new Agent({
        ...options,
        capabilities: { forkWithoutPrompt: 'required' },
      }).openSession({ resume: ref });

      await expect(source.forkAndSend('')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    }, 180_000);

    turnIt('returns and validates provider-native structured output', async () => {
      const turn = await new Agent(options).run('Return a JSON object whose ok field is true.', {
        outputSchema: {
          type: 'object',
          properties: { ok: { const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
        timeoutMs: 180_000,
      });
      expect(turn.output).toEqual({ ok: true });
    }, 240_000);

    turnIt('aborts without losing an already confirmed native session', async () => {
      const session = await new Agent(options).openSession({ resume: ref });
      const controller = new AbortController();
      const interrupted = session.send(
        'Think silently for a while, then reply OAR_TOO_LATE.',
        { signal: controller.signal, timeoutMs: 180_000 },
      );
      setTimeout(() => controller.abort(), 25);
      await expect(interrupted).rejects.toBeInstanceOf(AbortError);
      expect(session.state).toBe('interrupted');

      const recovered = await session.send('Reply with exactly OAR_RECOVERED_OK and nothing else.');
      expect(recovered.text).toContain('OAR_RECOVERED_OK');
      expect(session.ref?.id).toBe(ref.id);
    }, 360_000);

    it('reports the auth source without exposing account identity', async () => {
      const readiness = await new Agent(options).ready();

      expect(readiness.auth.authenticated).toBe(true);
      expect(readiness.auth.source).toBe('subscription');
      // El plan puede figurar; la identidad de la cuenta no. `claude auth
      // status --json` devuelve email y orgId en crudo, y el adapter no debe
      // propagarlos a ninguna superficie pública.
      const serialized = JSON.stringify(readiness);
      expect(serialized).not.toMatch(/@[\w.-]+\.\w+/);
      expect(serialized).not.toMatch(/orgId|organization|account_id|email/i);
    }, 120_000);

    turnIt('classifies an explicitly unavailable model without trusting exit code', async () => {
      const invalidModel = provider === 'claude'
        ? 'claude/claude-oar-definitely-unavailable'
        : 'codex/gpt-oar-definitely-unavailable';
      let code: string | undefined;
      try {
        await new Agent({ ...options, model: invalidModel }).run('Reply OK.', { timeoutMs: 90_000 });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      console.info(`[live:${provider}] unavailable-model=${code ?? 'NO_TYPED_ERROR'}`);
      expect(['UNKNOWN_MODEL', 'MODEL_UNAVAILABLE_FOR_AUTH']).toContain(code);
    }, 120_000);

    turnIt('resumes with an explicit same-provider model change and warns', async () => {
      const source = await new Agent(options).openSession();
      await source.send('Reply with exactly OAR_MODEL_SOURCE_OK and nothing else.');
      const sourceRef = source.export();
      const alternateModel = provider === 'claude' ? 'sonnet-5' : 'gpt-5.6-terra';
      const changed = await new Agent({ ...options, model: alternateModel })
        .openSession({ resume: sourceRef });
      const turn = await changed.send('Reply with exactly OAR_MODEL_CHANGED_OK and nothing else.');

      expect(turn.text).toContain('OAR_MODEL_CHANGED_OK');
      expect(turn.warnings).toContainEqual(expect.objectContaining({ code: 'SESSION_MODEL_CHANGED' }));
      expect(turn.session.id).toBe(sourceRef.id);
    }, 360_000);
  },
);
