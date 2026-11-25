import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CodexJsonlChannel } from '../../src/adapters/codex-control/jsonl-channel.js';
import { ProtocolError } from '../../src/public/errors.js';

describe('CodexJsonlChannel', () => {
  it('parses fragmented UTF-8 JSONL frames in receipt order', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: Array<Record<string, unknown>> = [];
    const channel = new CodexJsonlChannel({ input, output, maxFrameBytes: 1024 });
    const pump = channel.pump(async (message) => { received.push(message); });

    input.write(Buffer.from('{"method":"one"}\n{"method":"tw'));
    input.end(Buffer.from('o"}\n'));
    await pump;

    expect(received).toEqual([{ method: 'one' }, { method: 'two' }]);
  });

  it('awaits writable backpressure before reporting a frame written', async () => {
    let flushed = false;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          flushed = true;
          callback();
        }, 5);
      },
    });
    const channel = new CodexJsonlChannel({
      input: new PassThrough(),
      output,
      maxFrameBytes: 1024,
    });

    await channel.write({ id: 'c:1', method: 'model/list', params: {} });

    expect(flushed).toBe(true);
  });

  it('rejects malformed provider output at the protocol boundary', async () => {
    const input = new PassThrough();
    const channel = new CodexJsonlChannel({
      input,
      output: new PassThrough(),
      maxFrameBytes: 1024,
    });
    const pump = channel.pump(async () => undefined);
    input.end('not-json\n');

    await expect(pump).rejects.toBeInstanceOf(ProtocolError);
  });
});
