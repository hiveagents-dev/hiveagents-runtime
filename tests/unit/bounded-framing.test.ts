import { describe, expect, it } from 'vitest';

import { IncrementalLineDecoder } from '../../src/process/json-lines.js';
import { OutputLimitError } from '../../src/public/errors.js';

describe('IncrementalLineDecoder framing', () => {
  it('delivers a final frame that has no trailing newline', () => {
    const decoder = new IncrementalLineDecoder();

    expect(decoder.push(Buffer.from('{"kind":"result","ok":true}'))).toEqual([]);
    expect(decoder.finish()).toEqual(['{"kind":"result","ok":true}']);
  });

  it('reassembles multibyte UTF-8 codepoints split across chunk boundaries', () => {
    const decoder = new IncrementalLineDecoder();
    const payload = { emoji: '🎉', cjk: '漢字', accented: 'señal' };
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');

    const lines: string[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      lines.push(...decoder.push(bytes.subarray(index, index + 1)));
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual(payload);
  });

  it('splits an emoji exactly at every possible byte offset', () => {
    const emojiLine = Buffer.from('{"v":"🎉"}\n', 'utf8');
    for (let split = 1; split < emojiLine.length; split += 1) {
      const decoder = new IncrementalLineDecoder();
      const lines = [
        ...decoder.push(emojiLine.subarray(0, split)),
        ...decoder.push(emojiLine.subarray(split)),
      ];
      expect(JSON.parse(lines[0] ?? '')).toEqual({ v: '🎉' });
    }
  });

  it('passes deeply nested JSON through intact', () => {
    const decoder = new IncrementalLineDecoder();
    const depth = 1_000;
    const deep = `${'['.repeat(depth)}1${']'.repeat(depth)}`;

    const lines = decoder.push(Buffer.from(`${deep}\n`, 'utf8'));

    expect(lines).toEqual([deep]);
    expect(JSON.parse(lines[0] ?? '')).toBeDefined();
  });

  it('raises a typed limit error instead of buffering an unbounded frame', () => {
    const decoder = new IncrementalLineDecoder({ maxBufferedBytes: 64 });

    expect(() => decoder.push(Buffer.alloc(128, 0x61))).toThrow(OutputLimitError);
  });
});
