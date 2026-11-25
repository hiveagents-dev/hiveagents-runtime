// Fake codex app-server used by lifecycle tests. Modes:
//   eof-exit  (default) answer initialize; exit cleanly when stdin reaches EOF.
//   stubborn  answer initialize; ignore SIGTERM and stay alive after EOF so the
//             supervisor is forced to escalate to SIGKILL.
//   orphan    answer initialize; answer the next request with an orphan response
//             id (a structural RPC error) and then stay alive, ignoring EOF.
//   noisy     answer initialize; before answering any later request write a
//             non-JSON line to stdout, then answer normally.
//   huge      answer initialize; answer the next request with a single JSONL
//             frame above the channel's 8 MiB cap, then stay alive ignoring EOF.
//   stderr-flood  before answering any request, write 2 MiB to stderr and wait
//             until the pipe accepted it: a parent that never reads stderr
//             blocks the server forever, so no answer ever arrives.
import process from 'node:process';
import readline from 'node:readline';

const mode = process.argv[2] ?? 'eof-exit';
if (mode === 'stubborn' || mode === 'orphan' || mode === 'huge') {
  process.on('SIGTERM', () => {});
}

const lines = readline.createInterface({ input: process.stdin });
const STDERR_FLOOD_BYTES = 2 * 1024 * 1024;
let floods = 0;
function answer(payload) {
  const frame = `${JSON.stringify(payload)}\n`;
  if (mode !== 'stderr-flood') {
    process.stdout.write(frame);
    return;
  }
  floods += 1;
  const chunk = `${'e'.repeat(1023)}\n`;
  let written = 0;
  const pump = () => {
    while (written < STDERR_FLOOD_BYTES) {
      written += chunk.length;
      const last = written >= STDERR_FLOOD_BYTES;
      const text = last ? `flood-${floods}-end\n` : chunk;
      if (last) {
        process.stderr.write(text, () => process.stdout.write(frame));
        return;
      }
      if (!process.stderr.write(text)) {
        process.stderr.once('drain', pump);
        return;
      }
    }
  };
  pump();
}

lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    answer({ id: message.id, result: { userAgent: 'fake/1' } });
  } else if (message.id !== undefined && mode === 'orphan') {
    process.stdout.write(`${JSON.stringify({ id: 'orphan-id', result: {} })}\n`);
  } else if (message.id !== undefined && mode === 'huge') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { blob: 'x'.repeat(9 * 1024 * 1024) } })}\n`);
  } else if (message.id !== undefined) {
    if (mode === 'noisy') process.stdout.write('WARN: plain text on stdout\n');
    answer({ id: message.id, result: { ok: true } });
  }
});
lines.on('close', () => {
  if (mode === 'stubborn' || mode === 'orphan' || mode === 'huge') {
    setInterval(() => {}, 1_000);
  } else {
    process.exit(0);
  }
});
