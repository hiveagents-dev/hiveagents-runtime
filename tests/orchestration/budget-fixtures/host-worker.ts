import { DatabaseSync } from 'node:sqlite';
import { HostLedger } from '../../../src/orchestration/budget/host-ledger.ts';
const [file, mode] = process.argv.slice(2);
if (mode === 'lock') {
  const db = new DatabaseSync(file!); db.exec('BEGIN EXCLUSIVE');
  setTimeout(() => { db.exec('ROLLBACK'); db.close(); process.disconnect?.(); }, 150);
  process.send?.('locked');
} else {
  const ledger = new HostLedger({ databasePath: file!, providers: { claude: { concurrency: { mode: 'limited', maxConcurrent: 1 }, maxLaunchesPerHour: 100, maxLaunchesPerDay: 100, quotaCooldownMs: 80 } } });
  const r = ledger.reserve('claude', 'child'); if (!r.allowed) throw Error(r.reason);
  process.on('message', () => { ledger.release(r.reservation.token); ledger.close(); process.disconnect?.(); });
  process.send?.('held');
}
