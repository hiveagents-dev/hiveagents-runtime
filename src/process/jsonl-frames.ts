import { OutputLimitError } from '../public/errors.js';

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

/** The same UTF-8 byte policy applies to live chunks and returned transcripts. */
export function assertJsonlFrame(frame: string, limit = DEFAULT_MAX_FRAME_BYTES): void {
  if (Buffer.byteLength(frame, 'utf8') <= limit) return;
  throw new OutputLimitError({ retryable: false, sanitizedDiagnostics: { maxFrameBytes: limit } },
    `JSONL frame exceeded ${limit} buffered bytes`);
}

export function* jsonlFrames(raw: string): Iterable<string> {
  for (const line of raw.split(/\r?\n/)) { assertJsonlFrame(line); yield line; }
}
