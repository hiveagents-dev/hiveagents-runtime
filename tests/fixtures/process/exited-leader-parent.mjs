import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const descendant = spawn(process.execPath, [fileURLToPath(new URL('./exited-leader-descendant.mjs', import.meta.url))], {
  detached: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
descendant.once('message', () => {
  const id = `exited-leader-${process.pid}-${descendant.pid}`;
  const message = process.argv.includes('exec')
    ? { type: 'thread.started', thread_id: id }
    : { type: 'system', subtype: 'init', session_id: id };
  process.stdout.write(`${JSON.stringify(message)}\n`, () => process.exit(0));
});
