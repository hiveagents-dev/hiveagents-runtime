import { types } from 'node:util';
import type { CodexRecoveryRead } from './recovery.js';
import { ProtocolError, SessionMismatchError } from '../../public/errors.js';
import type { SessionIdentity, SessionPersistence } from '../../public/types.js';
import { stringValue } from '../provider.js';
import type { CodexDynamicToolHost } from './dynamic-tools.js';
import type { CodexThreadRegistry } from './identity.js';
import type { CodexDelivery, CodexControlProjector } from './projector.js';
import type { CodexRequester } from './requester.js';

export interface CodexThreadControlOptions {
  requester: CodexRequester;
  registry: CodexThreadRegistry;
  projector: CodexControlProjector;
  cwd: string;
  dynamicTools?: CodexDynamicToolHost;
}

export interface StartThreadInput {
  delivery: CodexDelivery;
  persistence?: SessionPersistence;
  model?: string;
  cwd?: string;
  providerParams?: Record<string, unknown>;
}

export interface ResumeThreadInput extends StartThreadInput {
  threadId: string;
  /**
   * The dynamic-tool registry hash recorded when the thread last ran. On
   * resume the currently registered tools must hash to the same value; a
   * mismatch is a typed error, never a silent rebind.
   */
  toolRegistryHash?: string;
  recovering?: boolean;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Result shapes are provider-controlled; accept the known spellings, fail typed otherwise. */
function extractThreadId(result: unknown): string {
  const raw = asObject(result);
  const threadId = stringValue(raw?.threadId ?? raw?.thread_id ?? asObject(raw?.thread)?.id);
  if (threadId === undefined) {
    throw new ProtocolError(
      { provider: 'codex', transport: 'control', retryable: false },
      'Codex App Server thread response did not include a thread id',
    );
  }
  return threadId;
}

function data(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const keys = Reflect.ownKeys(value); if (keys.length > 64) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) return undefined;
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function sameIds(raw: Record<string, unknown>, expected: string): boolean {
  return ['id', 'threadId', 'thread_id'].every(key => raw[key] === undefined || raw[key] === expected);
}
function idleThread(value: unknown, expected: string): Omit<CodexRecoveryRead, 'latestTurn'> | undefined {
  const raw = data(value), thread = data(raw?.thread), status = data(thread?.status);
  if (!raw || !thread || !sameIds(raw, expected) || thread.id !== expected || !sameIds(thread, expected)
    || status?.type !== 'idle' || Object.keys(status).length !== 1) return undefined;
  for (const key of ['cwd', 'model']) if (thread[key] !== undefined && (typeof thread[key] !== 'string' || !(thread[key] as string).length || (thread[key] as string).length > 4096)) return undefined;
  return { threadId: expected, status: 'idle', ...(thread.cwd === undefined ? {} : { cwd: thread.cwd as string }),
    ...(thread.model === undefined ? {} : { model: thread.model as string }) };
}
function latestTurn(value: unknown): CodexRecoveryRead['latestTurn'] | null | undefined {
  const raw = data(value); if (!raw || !Array.isArray(raw.data) || types.isProxy(raw.data) || raw.data.length > 1) return undefined;
  if (Object.getPrototypeOf(raw.data) !== Array.prototype || Reflect.ownKeys(raw.data).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(raw.data!, key)!, 'value'))) return undefined;
  const cursor = (v: unknown) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 4096);
  if (!cursor(raw.nextCursor) || !cursor(raw.backwardsCursor)) return undefined;
  if (!raw.data.length) return raw.nextCursor === null && raw.backwardsCursor === null ? null : undefined;
  const turn = data(raw.data[0]);
  if (!turn || !id(turn.id) || !['completed', 'failed', 'interrupted'].includes(turn.status as string)) return undefined;
  return Object.freeze({ id: turn.id, status: turn.status as 'completed' | 'failed' | 'interrupted' });
}

export class CodexThreadControl {
  readonly #requester: CodexRequester;
  readonly #registry: CodexThreadRegistry;
  readonly #projector: CodexControlProjector;
  readonly #cwd: string;
  readonly #dynamicTools: CodexDynamicToolHost | undefined;

  constructor(options: CodexThreadControlOptions) {
    this.#requester = options.requester;
    this.#registry = options.registry;
    this.#projector = options.projector;
    this.#cwd = options.cwd;
    this.#dynamicTools = options.dynamicTools;
  }

  async startThread(input: StartThreadInput): Promise<SessionIdentity> {
    const cwd = input.cwd ?? this.#cwd;
    const result = await this.#requester.request('thread/start', {
      cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...this.#dynamicToolParams(),
      ...(input.providerParams ?? {}),
    });
    return this.#adopt(extractThreadId(result), input, cwd);
  }

  async resumeThread(input: ResumeThreadInput): Promise<SessionIdentity> {
    this.#verifyToolRebind(input.toolRegistryHash);
    const cwd = input.cwd ?? this.#cwd;
    const result = await this.#requester.request('thread/resume', {
      threadId: input.threadId,
      cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...this.#dynamicToolParams(),
      ...(input.providerParams ?? {}),
    });
    const raw = data(result), nested = data(raw?.thread);
    if (!raw || !sameIds(raw, input.threadId) || (nested && !sameIds(nested, input.threadId))) throw new SessionMismatchError({ provider: 'codex', transport: 'control', retryable: false }, 'Resume returned a foreign thread identity');
    const threadId = stringValue(raw.threadId ?? raw.thread_id ?? nested?.id) ?? (input.recovering ? undefined : input.threadId);
    if (threadId === undefined) throw new ProtocolError({ provider: 'codex', transport: 'control', retryable: false }, 'Recovery resume did not confirm the thread identity');
    return this.#adopt(threadId, { ...input, persistence: input.persistence ?? 'provider' }, cwd);
  }

  async forkThread(sourceThreadId: string, input: StartThreadInput): Promise<SessionIdentity> {
    const cwd = input.cwd ?? this.#cwd;
    const result = await this.#requester.request('thread/fork', {
      threadId: sourceThreadId,
      cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.providerParams ?? {}),
    });
    const forkedId = extractThreadId(result);
    const identity = this.#adopt(forkedId, input, cwd, sourceThreadId);
    return identity;
  }

  async readThread(threadId: string): Promise<unknown> {
    return this.#requester.request('thread/read', { threadId });
  }

  async readForRecovery(threadId: string): Promise<CodexRecoveryRead | undefined> {
    const thread = idleThread(await this.#requester.request('thread/read', { threadId, includeTurns: false }), threadId);
    if (!thread) return undefined;
    const latest = latestTurn(await this.#requester.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
    return latest === undefined ? undefined : Object.freeze({ ...thread, ...(latest === null ? {} : { latestTurn: latest }) });
  }

  identity(threadId: string): SessionIdentity {
    return this.#registry.identity(threadId);
  }

  unsubscribe(threadId: string): void {
    this.#projector.unsubscribe(threadId);
  }

  #adopt(
    threadId: string,
    input: StartThreadInput,
    cwd: string,
    forkedFromId?: string,
  ): SessionIdentity {
    const identity = this.#registry.register({
      threadId,
      persistence: input.persistence ?? 'provider',
      ...('recovering' in input && input.recovering === true ? { recovering: true } : {}),
      cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(forkedFromId === undefined ? {} : { forkedFromId }),
      ...(this.#dynamicTools === undefined ? {} : { toolRegistryHash: this.#dynamicTools.registryHash() }),
    });
    this.#projector.subscribe(threadId, input.delivery);
    return identity;
  }

  #dynamicToolParams(): Record<string, unknown> {
    if (this.#dynamicTools === undefined || this.#dynamicTools.size === 0) return {};
    return { dynamicTools: this.#dynamicTools.wireDeclarations() };
  }

  #verifyToolRebind(expectedHash: string | undefined): void {
    if (expectedHash === undefined) return;
    const actual = this.#dynamicTools?.registryHash();
    if (actual === expectedHash) return;
    throw new SessionMismatchError(
      { provider: 'codex', transport: 'control', retryable: false },
      actual === undefined
        ? 'Thread was persisted with dynamic tools but none are registered for this resume'
        : 'Dynamic tool registry hash mismatch on resume; refusing silent rebind',
    );
  }
}
