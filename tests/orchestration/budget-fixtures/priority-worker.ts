import { existsSync, writeFileSync } from 'node:fs';
import { HostLedger } from '../../../src/orchestration/budget/host-ledger.ts';

// One independent process that waits for a slot at the given priority and reports its admission.
const [file, owner, priority] = process.argv.slice(2);
const ledger = new HostLedger({
  databasePath: file!,
  providers: {
    claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 80 },
  },
});
let token: string | undefined;

process.on('message', (message) => {
  if (message === 'stall') {
    // Block this process until the test lets it go. Ledger transactions are synchronous, so none
    // is open here. The marker is written in the same synchronous stretch that enters the block:
    // once the test sees it, this process cannot attempt admission until the resume file exists.
    writeFileSync(`${file}.${owner}.stalled`, '');
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(`${file}.${owner}.resume`)) Atomics.wait(sleeper, 0, 0, 5);
    return;
  }
  if (token !== undefined) ledger.release(token);
  ledger.close();
  process.disconnect?.();
});

const options = priority === 'low' ? { maxWaitMs: 60_000, priority: 'low' as const } : { maxWaitMs: 60_000 };
const admission = await ledger.acquire('claude', owner!, options);
if (!admission.allowed) throw new Error(admission.reason);
token = admission.reservation.token;
process.send?.({ event: 'admitted', owner });
