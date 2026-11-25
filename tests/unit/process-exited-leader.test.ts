import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeExecAdapter } from '../../src/adapters/claude/exec-adapter.js';
import { CodexExecAdapter } from '../../src/adapters/codex/exec-adapter.js';
import { runProcess } from '../../src/process/run-process.js';
import { Session } from '../../src/session/session.js';

const fixture = fileURLToPath(new URL('../fixtures/process/exited-leader-parent.mjs', import.meta.url));
type Identities = { leader: number; descendant: number };

function identities(raw: string): Identities {
  const matched = /exited-leader-(\d+)-(\d+)/.exec(raw);
  if (!matched) throw new Error('Fixture did not announce its synthetic process identities');
  return { leader: Number(matched[1]), descendant: Number(matched[2]) };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function bounded<T>(work: Promise<T>, ms = 1_500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Exited leader kept inherited stdio open past the cleanup boundary')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function exited(pid: number): Promise<void> {
  const until = Date.now() + 1_000;
  while (alive(pid)) {
    if (Date.now() >= until) throw new Error('Synthetic process did not exit within the test deadline');
    await delay(5);
  }
}

// Test-only recovery of the freshly announced, still-live synthetic group.
// This is not a production process identity or containment guarantee.
function cleanFixture(id: Identities | undefined): void {
  if (!id || !alive(id.descendant)) return;
  try { process.kill(-id.leader, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

describe.runIf(process.platform !== 'win32')('same-group stdio after native leader exit', () => {
  it('retains uncertain settlement until external owned-fixture cleanup closes inherited pipes', async () => {
    let id: Identities | undefined, announce!: () => void;
    const announced = new Promise<void>(resolve => { announce = resolve; });
    const running = runProcess({ command: process.execPath, args: [fixture], cwd: process.cwd(), env: {},
      stdin: '', timeoutMs: 500, killGraceMs: 20, maxOutputBytes: 1024,
      onStdout(chunk) { id = identities(Buffer.from(chunk).toString()); announce(); },
    }).then(value => ({ value }), error => ({ error }));
    try {
      await bounded(announced); await exited(id!.leader);
      expect(alive(id!.descendant)).toBe(true);
      let settled = false; void running.then(() => { settled = true; });
      await delay(550); expect(settled).toBe(false); expect(alive(id!.descendant)).toBe(true);
      cleanFixture(id);
      expect(await bounded(running)).toMatchObject({ error: { code: 'TIMEOUT' } });
      await exited(id!.descendant);
    } finally { cleanFixture(id); await bounded(running); }
  });

  it.each([{ name: 'Claude', Adapter: ClaudeExecAdapter }, { name: 'Codex', Adapter: CodexExecAdapter }])(
    'keeps $name awaitSettlement pending until externally owned cleanup after leader exit', async ({ Adapter }) => {
      const adapter = new Adapter({ target: { command: process.execPath, argsPrefix: [fixture] } });
      const owner = new Session({ adapter,
        model: { id: 'fixture-model', provider: adapter.id, aliases: [], source: 'explicit', availability: 'available' },
        cwd: process.cwd(), transport: 'exec', persistence: 'provider', contextArgs: [], permissionArgs: [],
        env: {}, warnings: [], features: {},
      });
      const iterator = owner.stream('fixture', { timeoutMs: 5_000, awaitSettlement: true })[Symbol.asyncIterator]();
      let id: Identities | undefined, returning: Promise<unknown> | undefined;
      try {
        const event = (await bounded(iterator.next())).value;
        expect(event?.type).toBe('session.started');
        if (event?.type !== 'session.started') throw new Error('Fixture session was not announced');
        id = identities(event.session.id); await exited(id.leader);
        expect(alive(id.descendant)).toBe(true);
        returning = iterator.return!();
        let settled = false; void returning.then(() => { settled = true; });
        await delay(60); expect(settled).toBe(false); expect(alive(id.descendant)).toBe(true);
        cleanFixture(id);
        await bounded(returning); await exited(id.descendant);
        // No terminal provider response was observed; keep the conservative
        // session state while proving the native runner really settled.
        expect(owner.state).toBe('unknown');
      } finally {
        cleanFixture(id);
        if (returning) await bounded(returning);
        else await bounded(iterator.return!());
        await owner.close();
      }
    },
  );
});
