import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CodexAppServerConnection } from '../../src/adapters/codex-control/connection.js';
import { CodexAppServerSupervisor } from '../../src/adapters/codex-control/supervisor.js';
import { ProtocolError } from '../../src/public/errors.js';

const fixture = fileURLToPath(new URL('../fixtures/process/fixture-cli.mjs', import.meta.url));

describe('CodexAppServerConnection', () => {
  it('performs initialize then initialized before exposing a ready connection', async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const frames: Array<Record<string, unknown>> = [];
    let buffered = '';
    toServer.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        if (frame.method === 'initialize') {
          fromServer.write(`${JSON.stringify({ id: frame.id, result: { userAgent: 'codex/0.149.0' } })}\n`);
        }
      }
    });
    const connection = new CodexAppServerConnection({
      input: fromServer,
      output: toServer,
      epoch: 'epoch-1',
    });

    await connection.initialize();

    expect(frames.map(({ method }) => method)).toEqual(['initialize', 'initialized']);
    expect(frames[0]?.params).toEqual({
      clientInfo: {
        name: 'open_agent_runtime',
        title: 'HiveAgents Runtime',
        version: '0.1.0-beta.3',
      },
    });
    await connection.close();
  });
});

describe('CodexAppServerSupervisor', () => {
  it('owns a persistent stdio child from handshake through deterministic close', async () => {
    const supervisor = await CodexAppServerSupervisor.start({
      command: process.execPath,
      args: [fixture, 'app-server-fixture'],
      cwd: process.cwd(),
      env: process.env,
      experimentalApi: false,
    });

    await expect(supervisor.connection.request('model/list', {})).resolves.toEqual({
      data: [{ id: 'fixture-model' }],
    });
    await supervisor.close();

    expect(supervisor.closed).toBe(true);
  });
});

function harness(options: { onDeath?: (error: unknown) => void; onNoise?: (line: string) => void } = {}) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const notifications: string[] = [];
  let buffered = '';
  toServer.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
      buffered = buffered.slice(newline + 1);
      if (frame.method === 'initialize') {
        fromServer.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
      }
    }
  });
  const connection = new CodexAppServerConnection({
    input: fromServer,
    output: toServer,
    epoch: 'epoch-1',
    onNotification: (method) => { notifications.push(method); },
    ...options,
  });
  return { connection, fromServer, notifications };
}

describe('CodexAppServerConnection transport death (R3)', () => {
  it('reports a structural RPC error as death and fails pending requests with the cause', async () => {
    const deaths: unknown[] = [];
    const { connection, fromServer } = harness({ onDeath: (error) => deaths.push(error) });
    await connection.initialize();
    const pending = connection.request('turn/interrupt', { threadId: 't1' });
    const started = Date.now();

    fromServer.write(`${JSON.stringify({ id: 'orphan-id', result: {} })}\n`);

    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(Date.now() - started).toBeLessThan(100);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toBeInstanceOf(ProtocolError);
    // Public diagnostics identify closure without interpolating a prior cause.
    await expect(connection.request('turn/interrupt', { threadId: 't1' }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', context: { sanitizedDiagnostics: { kind: 'rpc-closed' } } });
    await connection.close();
  });

  it('reports the stream ending as death exactly once and never after close()', async () => {
    const deaths: unknown[] = [];
    const { connection, fromServer } = harness({ onDeath: (error) => deaths.push(error) });
    await connection.initialize();

    fromServer.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deaths).toHaveLength(1);

    const quiet = harness({ onDeath: (error) => deaths.push(error) });
    await quiet.connection.initialize();
    await quiet.connection.close();
    expect(deaths).toHaveLength(1);
  });

  it('ends as transport death with a typed error when a frame exceeds the channel cap', async () => {
    const deaths: unknown[] = [];
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    toServer.on('data', (chunk) => {
      const frame = JSON.parse(chunk.toString('utf8').trim()) as Record<string, unknown>;
      if (frame.method === 'initialize') fromServer.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
    });
    const connection = new CodexAppServerConnection({
      input: fromServer,
      output: toServer,
      epoch: 'epoch-1',
      maxFrameBytes: 1024 * 1024,
      onDeath: (error) => deaths.push(error),
    });
    await connection.initialize();
    const pending = connection.request('turn/start', { threadId: 't1' });
    const started = Date.now();

    fromServer.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'x'.repeat(1024 * 1024 + 1) } })}\n`);

    await expect(pending).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(Date.now() - started).toBeLessThan(100);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toMatchObject({ code: 'OUTPUT_LIMIT' });
    await connection.close();
  });

  it('tolerates a non-JSON stdout line as noise and keeps delivering frames', async () => {
    const deaths: unknown[] = [];
    const noise: string[] = [];
    const { connection, fromServer, notifications } = harness({
      onDeath: (error) => deaths.push(error),
      onNoise: (line) => noise.push(line),
    });
    await connection.initialize();

    fromServer.write('WARN: plain text on stdout\n');
    fromServer.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'x' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(noise).toEqual(['WARN: plain text on stdout']);
    expect(notifications).toEqual(['item/agentMessage/delta']);
    expect(deaths).toHaveLength(0);
    await connection.close();
  });
});
