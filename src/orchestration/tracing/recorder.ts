import type { AgentEvent } from '../../public/types.js';
import { projectAgentEvent } from './projector.js';
import type { TraceEpisode, TraceEventInput, TraceIdentity, TraceRecorder, TraceStore, TraceTerminalStatus } from './types.js';
import { canonical, identifier, MAX_TRACE_ENTRIES, sealEpisode, validateEpisode, validateEvent, validateIdentity } from './validation.js';

export async function openTraceEpisode(store: TraceStore, identity: TraceIdentity): Promise<TraceRecorder> {
  const bound = validateIdentity(identity);
  const lease = await store.acquire(bound.episodeId);
  try {
    const loaded = await lease.load();
    const now = Date.now();
    let current = loaded === undefined ? sealEpisode({ format: 1, identity: bound, status: 'running', startedAt: now, updatedAt: now, entries: [] })
      : validateEpisode(loaded, bound.episodeId);
    if (canonical(current.identity) !== canonical(bound)) throw new Error('Trace identity does not match episode');
    if (current.status !== 'running') throw new Error('Trace episode is finished');
    if (loaded === undefined) await lease.save(current);
    let operations: Promise<unknown> = Promise.resolve();
    let closing: Promise<void> | undefined;
    let failure: unknown;
    let failed = false;
    let sessionId: string | undefined, turnId: string | undefined;
    for (const entry of current.entries) {
      if (entry.sessionId !== undefined) sessionId = entry.sessionId;
      if (entry.turnId !== undefined) turnId = entry.turnId;
      if (entry.type === 'session.started') { sessionId = entry.sessionId; turnId = undefined; }
      if (entry.type === 'turn.started') turnId = entry.turnId;
    }
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new Error('Trace recorder is closed'));
      const pending = operations.then(async () => {
        if (failed) throw failure;
        return operation();
      });
      operations = pending.catch(() => undefined);
      return pending;
    };
    const persist = async (next: TraceEpisode) => {
      validateEpisode(next, bound.episodeId);
      try { await lease.save(next); }
      catch (error) { failed = true; failure = error; throw error; }
      current = next;
    };
    const append = async (event: TraceEventInput) => {
      if (current.status !== 'running') throw new Error('Trace episode is finished');
      if (current.entries.length >= MAX_TRACE_ENTRIES) throw new Error('Trace entry limit exceeded');
      const timestamp = Math.max(Date.now(), current.updatedAt);
      const { digest: _digest, ...body } = current;
      await persist(sealEpisode({ ...body, updatedAt: timestamp,
        entries: [...current.entries, { ...event, sequence: current.entries.length + 1, timestamp }] }));
    };
    return {
      async append(event) { const captured = validateEvent(event); return serial(() => append(captured)); },
      async observe(event: AgentEvent) {
        const captured = projectAgentEvent(event);
        return serial(async () => {
          const nextSession = captured.sessionId ?? sessionId;
          const nextTurn = captured.type === 'session.started' ? undefined
            : captured.type === 'turn.started' ? captured.turnId : captured.turnId ?? turnId;
          await append({ ...captured, ...(nextSession === undefined ? {} : { sessionId: nextSession }),
            ...(nextTurn === undefined ? {} : { turnId: nextTurn }) });
          sessionId = nextSession; turnId = nextTurn;
        });
      },
      snapshot: () => current,
      finish(status: TraceTerminalStatus) {
        return serial(async () => {
          if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error('Invalid trace terminal status');
          if (current.status !== 'running') {
            if (current.status === status) return current;
            throw new Error('Trace episode is finished');
          }
          const { digest: _digest, ...body } = current;
          const timestamp = Math.max(Date.now(), current.updatedAt);
          await persist(sealEpisode({ ...body, status, updatedAt: timestamp, finishedAt: timestamp }));
          return current;
        });
      },
      close() {
        closing ??= operations.then(() => lease.release());
        return closing;
      },
    };
  } catch (error) {
    try { await lease.release(); } catch (releaseError) { throw new AggregateError([error, releaseError], 'Trace open and lease release failed'); }
    throw error;
  }
}

export async function readTraceEpisode(store: TraceStore, episodeId: string): Promise<TraceEpisode | undefined> {
  // Validate before acquiring a user-supplied storage port.
  identifier(episodeId, 'episodeId');
  const lease = await store.acquire(episodeId);
  try { const value = await lease.load(); return value === undefined ? undefined : validateEpisode(value, episodeId); }
  finally { await lease.release(); }
}
