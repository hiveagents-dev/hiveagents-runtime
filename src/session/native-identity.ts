import { isSafeSessionId } from '../adapters/provider.js';
import { ProtocolError } from '../public/errors.js';
import type { SessionIdentity, Usage } from '../public/types.js';
import type { SessionConfig } from './config.js';

/** One boundary for announced and terminal identities, including failed native turns. */
export function assertNativeSessionIdentity(config: SessionConfig, previous: SessionIdentity | undefined,
  id: unknown, usage?: Usage): void {
  const message = !isSafeSessionId(id) ? 'Provider confirmed an invalid native session id'
    : previous && previous.id !== id ? 'Provider changed the native session id during a non-fork turn' : undefined;
  if (message === undefined) return;
  throw new ProtocolError({ provider: config.adapter.id, transport: config.transport, retryable: false,
    ...(previous === undefined ? {} : { session: previous }),
    ...(usage === undefined ? {} : { observedUsage: structuredClone(usage) }),
  }, message);
}

/** The identity of the native session `id`; a missing transport epoch gets a fresh one. */
export function nativeRef(config: SessionConfig, id: string, modelId: string, transportEpoch: string | undefined, createdAt: string): SessionIdentity {
  return {
    schemaVersion: 1,
    provider: config.adapter.id,
    id,
    model: modelId,
    cwd: config.cwd,
    transport: config.transport,
    persistence: config.persistence,
    transportEpoch: transportEpoch ?? crypto.randomUUID(),
    ...(config.cliVersion === undefined ? {} : { cliVersion: config.cliVersion }),
    createdAt,
  };
}
