// Simulated runtime parent: spawns the fake app-server over pipe stdio the way
// the supervisor does, prints the server pid, then idles until it is killed.
// When this parent dies (even SIGKILL), the server's stdin pipe closes and the
// server must exit on EOF — proving no orphan survives a parent crash.
import { spawn } from 'node:child_process';
import process from 'node:process';

const server = spawn(
  process.execPath,
  [new URL('fake-app-server.mjs', import.meta.url).pathname, 'eof-exit'],
  { detached: false, stdio: ['pipe', 'pipe', 'ignore'] },
);
process.stdout.write(`${server.pid}\n`);
setInterval(() => {}, 1_000);
