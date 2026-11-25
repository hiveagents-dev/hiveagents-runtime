import { watch, type FSWatcher } from 'node:fs';

/** Event hint only: callers always recheck SQLite. Arming precedes the admission attempt. */
export function armBell(path: string, signal: AbortSignal | undefined) {
  let rang = false, settled = false;
  let watcher: FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let resolve: (() => void) | undefined, reject: ((reason: unknown) => void) | undefined;
  let aborted = false;
  const cleanup = () => {
    watcher?.close(); watcher = undefined;
    clearTimeout(timer); timer = undefined;
    signal?.removeEventListener('abort', abort);
  };
  const finish = () => {
    if (settled) return;
    settled = true; cleanup();
    if (aborted) reject?.(signal?.reason); else resolve?.();
  };
  const abort = () => { aborted = true; rang = true; finish(); };
  try {
    watcher = watch(path, { persistent: false }, () => { rang = true; if (resolve) finish(); });
    watcher.on('error', () => { watcher?.close(); watcher = undefined; });
  } catch { /* A missing event cannot authorize admission; the bounded backstop remains. */ }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    cancel: finish,
    wait(ms: number): Promise<void> {
      if (aborted) return Promise.reject(signal?.reason);
      if (settled) return Promise.resolve();
      return new Promise<void>((yes, no) => {
        resolve = yes; reject = no;
        timer = setTimeout(finish, Math.max(1, Math.min(2_147_483_647, Math.ceil(ms))));
        if (rang) finish();
      });
    },
  };
}
