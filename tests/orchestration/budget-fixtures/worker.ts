import { randomUUID } from 'node:crypto';
import type { SharedLaunchBudget, LaunchAdmission, LaunchReservation } from '../../../src/orchestration/budget/index.ts';

// Synthetic work only: hold an admitted slot until the parent releases it.
// The local baseline deliberately has one separate counter per application.
const [mode, databasePath, capacityText, hourText, dayText] = process.argv.slice(2);
const capacity = Number(capacityText);
let budget: SharedLaunchBudget | undefined;
let reservation: LaunchReservation | undefined;
let localActive = 0;

process.on('message', async (message) => {
  try {
    if (message === 'reserve') {
      let result: LaunchAdmission;
      if (mode === 'local') {
        result = localActive < capacity
          ? { allowed: true, reservation: { token: randomUUID(), providerKey: 'test:account', owner: String(process.pid), admittedAt: Date.now() } }
          : { allowed: false, reason: 'concurrency-limit' };
        if (result.allowed) localActive++;
      } else {
        const { SharedLaunchBudget } = await import('../../../src/orchestration/budget/index.ts');
        budget = new SharedLaunchBudget({ databasePath: databasePath!, providers: {
          'test:account': { maxConcurrent: capacity, maxLaunchesPerHour: Number(hourText), maxLaunchesPerDay: Number(dayText), quotaCooldownMs: 60_000 },
        } });
        result = budget.reserve('test:account', String(process.pid));
      }
      if (result.allowed) reservation = result.reservation;
      process.send?.({ event: 'attempt', pid: process.pid, result });
    } else if (message === 'release') {
      const result = reservation && budget ? budget.release(reservation.token) : { ok: true };
      localActive = 0;
      budget?.close();
      process.send?.({ event: 'released', pid: process.pid, result });
      process.disconnect?.();
    }
  } catch (error) {
    process.send?.({ event: 'error', detail: String(error) });
    process.exitCode = 1;
    process.disconnect?.();
  }
});
process.send?.({ event: 'ready', pid: process.pid });
