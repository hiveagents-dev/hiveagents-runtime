import { spawn } from 'node:child_process';
import process from 'node:process';
import readline from 'node:readline';

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'app-server-fixture') {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fixture/1' } })}\n`);
    } else if (message.method === 'model/list') {
      process.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [{ id: 'fixture-model' }] } })}\n`);
    }
  }
  process.exit(0);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk.toString();

if (mode === 'echo') {
  process.stdout.write(JSON.stringify({ argv: rest, stdin }));
} else if (mode === 'stderr') {
  process.stdout.write('out');
  process.stderr.write('err');
} else if (mode === 'jsonl') {
  process.stdout.write('{"n":1}\n{"n"');
  setTimeout(() => process.stdout.write(':2}\n'), 10);
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else if (mode === 'spawn-tree') {
  // Before the spawn: a SIGTERM that arrives while the descendant starts must not end the leader.
  process.on('SIGTERM', () => {});
  // The pid is announced once the descendant has installed its own SIGTERM handler, so only the
  // group SIGKILL can end it: a SIGTERM that reaches it while it boots would prove nothing.
  const body = JSON.stringify(new URL('tree-descendant.mjs', import.meta.url).href);
  const descendant = spawn(process.execPath, ['--input-type=module', '-e', `await import(${body}); process.stdout.write('ready');`], {
    detached: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  descendant.stdout.once('data', () => process.stdout.write(`${descendant.pid}\n`));
  setInterval(() => {}, 1_000);
} else if (mode === 'spawn-tree-parent-exits') {
  const code = rest[0]
    ? `const {writeFileSync}=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(rest[0])},'flushed');process.exit(0)},60));process.stdout.write('ready');setInterval(()=>{},1000)`
    : "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
  const descendant = spawn(process.execPath, ['-e', code], {
    detached: false, stdio: ['ignore', 'pipe', 'ignore'],
  });
  descendant.stdout.once('data', () => process.stdout.write(`${descendant.pid}\n`));
  setInterval(() => {}, 1_000);
} else if (mode === 'large') {
  process.stdout.write('x'.repeat(Number(rest[0] ?? 1024)));
} else if (mode === 'exit') {
  process.exitCode = Number(rest[0] ?? 0);
} else if (mode === 'bigline') {
  // One oversized JSONL frame without its newline (a tool_result carrying a
  // large body), then idle: a well-behaved host must terminate this process.
  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: `pid-${process.pid}` })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `pid-${process.pid}` })}\n`);
  process.stdout.write(`{"type":"user","content":"${'x'.repeat(Number(rest[0] ?? 1_200_000))}`);
  // 'ignore-sigterm' keeps the child alive until SIGKILL, so a later timer or
  // abort can race against the error that already terminated the turn.
  if (rest[1] === 'ignore-sigterm') process.on('SIGTERM', () => {});
  setTimeout(() => process.stdout.write('"}\n'), 15_000);
}
