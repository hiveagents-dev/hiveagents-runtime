// close() waits for pending memory captures, each bounded by MEMORY_CAPTURE_TIMEOUT_MS. A capture
// that holds no handle of its own must not let the process exit while close() waits for it: the
// code after close() runs and the failure is reported. Runs the built package (npm run build).
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const dist = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const run = promisify(execFile);

function script(close: string): string {
  return `
    import { Agent, Runtime } from ${JSON.stringify(pathToFileURL(dist).href)};
    const exec = { id: 'claude',
      async detect() { return { installed: true, path: '/bin/claude', version: '1.0.0' }; },
      async auth() { return { authenticated: true, source: 'subscription' }; },
      async models() { return []; },
      async execute() { return { completed: true, failed: false, refused: false, sessionId: 's1', text: 'ok', events: [], nativeEvents: [] }; } };
    // A capture that never settles and holds nothing that keeps the event loop alive.
    const provider = { id: 'hung', recall: async () => [], capture: () => new Promise(() => {}) };
    const agent = new Agent({ model: 'opus-5', memory: { provider, scope: { tenant: 't', namespace: 'n' }, capture: true,
      onCaptureError: (error) => console.log('reported ' + error.code) } }, new Runtime({ adapters: [exec] }));
    ${close}
    console.log('closed');
  `;
}

async function outcome(close: string) {
  const code = script(close);
  try {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 });
    return { status: 0, stdout: stdout.trim().split('\n') };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { status: failed.code, stdout: (failed.stdout ?? '').trim().split('\n') };
  }
}

describe('close() keeps the process alive while it waits for a capture', () => {
  it('Agent.close() and Session.close() return after the capture deadline, never before', async () => {
    const [agentClose, sessionClose] = await Promise.all([
      outcome(`await agent.send('hola'); await agent.close();`),
      outcome(`const session = await agent.openSession(); await session.send('hola'); await session.close();`),
    ]);
    expect(agentClose).toEqual({ status: 0, stdout: ['reported TIMEOUT', 'closed'] });
    expect(sessionClose).toEqual({ status: 0, stdout: ['reported TIMEOUT', 'closed'] });
  }, 40_000);
});
