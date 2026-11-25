import { SystemInbox } from '../../../src/orchestration/inbox/index.js';

// One independent process with its own connection. It opens the inbox, says it is ready and acts
// only when the parent says so, so every contender is already at the starting line.
const [mode, file, requestId] = process.argv.slice(2);
const payload = { to: 'ana@example.com', subject: 'Propuesta', body: 'Hola Ana, te paso la propuesta.' };

if (!mode || !file) throw new Error('worker arguments missing');

process.on('message', (message) => {
  if (message !== 'go') return;
  try {
    const inbox = new SystemInbox({
      databasePath: file,
      systemId: 'grow',
      irreversibleActions: ['email.send'],
      display: { 'email.send': [{ label: 'Para', path: ['to'] }] },
      busyTimeoutMs: 15_000,
    });
    const by = `grow:pid-${process.pid}`;
    const result = mode === 'consume'
      ? inbox.consume({ requestId: requestId!, actionKind: 'email.send', payload, by })
      : inbox.request({ actionKind: 'email.send', payload, requestedBy: by });
    inbox.close();
    process.send?.({ event: 'result', pid: process.pid, result });
  } catch (error) {
    process.send?.({ event: 'error', pid: process.pid, detail: String(error) });
    process.exitCode = 1;
  }
  process.disconnect?.();
});
process.send?.({ event: 'ready', pid: process.pid });
