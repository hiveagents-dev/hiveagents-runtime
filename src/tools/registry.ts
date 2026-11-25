import { createHash } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import { OperationScope } from '../control/operation-scope.js';
import { AgentRuntimeError, ApprovalRequiredError, OutputLimitError, ProtocolError, TimeoutError } from '../public/errors.js';
import { canonical } from '../shared/json.js';
import type { ApplicationTool, ApplicationToolScope } from './types.js';

const MAX_LIMIT = 2 ** 31 - 1;
const MAX_TOOLS = 128;
// Each declaration owns its schema namespace; repeated $id values cannot poison other agents.
const compileSchema = (schema: Record<string, unknown>): ValidateFunction =>
  new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema);

function jsonCopy(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Expected serializable JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => jsonCopy(entry, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Expected JSON object');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonCopy(entry, seen)]));
  } finally { seen.delete(value); }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

/** Copy JSON metadata while preserving only the two application callback references. */
export function snapshotApplicationTools(tools: readonly ApplicationTool[]): readonly ApplicationTool[] {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) throw new TypeError(`At most ${MAX_TOOLS} application tools are allowed`);
  const names = new Set<string>();
  return Object.freeze(tools.map(tool => {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) throw new TypeError('Invalid application tool name');
    if (names.has(tool.name)) throw new TypeError(`Duplicate application tool name: ${tool.name}`);
    names.add(tool.name);
    if (typeof tool.description !== 'string' || Buffer.byteLength(tool.description) > 65536) throw new TypeError('Invalid application tool description');
    for (const limit of [tool.timeoutMs, tool.maxOutputBytes]) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('Tool limits must be integers in 1..2^31-1');
    }
    if (typeof tool.authorize !== 'function' || typeof tool.execute !== 'function') throw new TypeError('Application tools require authorize and execute callbacks');
    const inputSchema = jsonCopy(tool.inputSchema) as Record<string, unknown>;
    if (inputSchema === null || Array.isArray(inputSchema) || typeof inputSchema !== 'object' || Buffer.byteLength(JSON.stringify(inputSchema)) > 1048576) throw new TypeError('Invalid application tool input schema');
    try { compileSchema(inputSchema); } catch { throw new TypeError(`Invalid input schema for application tool ${tool.name}`); }
    return freeze({ name: tool.name, description: tool.description, inputSchema, timeoutMs: tool.timeoutMs, maxOutputBytes: tool.maxOutputBytes,
      authorize: tool.authorize, execute: tool.execute });
  }));
}

export interface ApplicationToolCallOptions {
  signal: AbortSignal;
  deadline?: number;
  scope: Readonly<ApplicationToolScope>;
}

/** Validates, authorizes and executes under one derived cancellation/deadline scope. */
export class ApplicationToolRegistry {
  readonly #tools = new Map<string, { definition: ApplicationTool; validate: ValidateFunction }>();
  readonly #hash: string;
  readonly #pending = new Map<string, number>();
  constructor(tools: readonly ApplicationTool[]) {
    for (const definition of snapshotApplicationTools(tools)) this.#tools.set(definition.name, { definition, validate: compileSchema(definition.inputSchema) });
    this.#hash = createHash('sha256').update(canonical([...this.#tools.values()].map(({ definition: { authorize: _a, execute: _e, ...metadata } }) => metadata).sort((a,b) => a.name.localeCompare(b.name)))).digest('hex');
  }
  get size(): number { return this.#tools.size; }
  has(name: string): boolean { return this.#tools.has(name); }
  registryHash(): string { return this.#hash; }
  hasPending(sessionId?: string): boolean { return sessionId === undefined ? this.#pending.size > 0 : (this.#pending.get(sessionId) ?? 0) > 0; }
  declarations(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.#tools.values()].map(({ definition }) => ({ name: definition.name, description: definition.description, inputSchema: jsonCopy(definition.inputSchema) as Record<string, unknown> }));
  }
  async call(name: string, input: unknown, options: ApplicationToolCallOptions): Promise<unknown> {
    const errorContext = { provider: options.scope.provider, transport: options.scope.transport, retryable: false };
    const registered = this.#tools.get(name);
    if (!registered) throw new ProtocolError(errorContext, 'Application tool is not registered');
    const { definition, validate } = registered;
    let safeInput: unknown;
    try { safeInput = freeze(jsonCopy(input)); } catch { throw new ProtocolError(errorContext, `Application tool ${name} requires JSON input`); }
    if (!validate(safeInput)) throw new ProtocolError(errorContext, `Application tool ${name} input failed its schema`);
    const remaining = options.deadline === undefined ? definition.timeoutMs : options.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new TimeoutError(errorContext);
    const controller = new AbortController();
    const operation = new OperationScope({ timeoutMs: Math.max(1, Math.min(definition.timeoutMs, Math.floor(remaining))), signal: AbortSignal.any([options.signal, controller.signal]), context: errorContext });
    const context = Object.freeze({ signal: operation.signal, deadline: operation.deadline, scope: Object.freeze({ ...options.scope }) });
    try {
      const allowed = await operation.race(() => this.#invoke(options.scope.sessionId, () => definition.authorize(safeInput, context), errorContext, name));
      if (allowed !== true) throw new ApprovalRequiredError(errorContext, `Application tool ${name} was denied by its authorizer`);
      const output = await operation.race(() => this.#invoke(options.scope.sessionId, () => definition.execute(safeInput, context), errorContext, name));
      let result: unknown;
      try { result = jsonCopy(output); } catch { throw new ProtocolError(errorContext, `Application tool ${name} returned non-JSON output`); }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > definition.maxOutputBytes) throw new OutputLimitError(errorContext, `Application tool ${name} output exceeded its byte limit`);
      return result;
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw error;
      throw new ProtocolError(errorContext, `Application tool ${name} callback failed`);
    } finally { controller.abort(); operation.dispose(); }
  }
  #invoke<T>(sessionId: string, callback: () => T | Promise<T>, context: { provider: string; transport: 'exec' | 'control'; retryable: boolean }, name: string): Promise<T> {
    this.#pending.set(sessionId, (this.#pending.get(sessionId) ?? 0) + 1);
    const clear = () => {
      const left = (this.#pending.get(sessionId) ?? 1) - 1;
      if (left > 0) this.#pending.set(sessionId, left); else this.#pending.delete(sessionId);
    };
    let result: T | Promise<T>;
    try { result = callback(); }
    catch { clear(); return Promise.reject(new ProtocolError(context, `Application tool ${name} callback failed`)); }
    return Promise.resolve(result).then(value => { clear(); return value; }, () => {
      clear(); throw new ProtocolError(context, `Application tool ${name} callback failed`);
    });
  }

}
