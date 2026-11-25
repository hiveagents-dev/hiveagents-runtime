import { SqliteRunLogStore } from '../../../src/orchestration/log/sqlite-store.js';
import { logCommit } from '../log-store-fixture.js';
const [file, mode] = process.argv.slice(2);
if (!file) throw Error('fixture file missing');
const store = new SqliteRunLogStore({ databasePath: file, systemId: 'fixture' });
if (mode === 'crash') {
  await store.append(logCommit());
  process.kill(process.pid, 'SIGKILL');
} else {
  const receipt = await store.append(logCommit());
  store.close(); process.stdout.write(JSON.stringify(receipt));
}
