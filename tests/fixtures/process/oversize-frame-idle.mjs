import { once } from 'node:events';
const provider = process.argv[2];
const initial = provider === 'claude'
  ? { type: 'system', subtype: 'init', session_id: 'native-fixture' }
  : { type: 'thread.started', thread_id: 'native-fixture' };
process.stdout.write(JSON.stringify(initial) + '\n');
// A complete oversized frame never arrives: incremental validation must stop
// this owned idle process rather than waiting for its turn deadline.
if (!process.stdout.write('x'.repeat(1024 * 1024 + 1))) await once(process.stdout, 'drain');
setInterval(() => {}, 1000);
