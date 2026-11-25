import { createHash } from 'node:crypto';

import { OperationScope } from '../../control/operation-scope.js';
import Ajv, { type ValidateFunction } from 'ajv';

import {
  AbortError,
  OutputLimitError,
  ProtocolError,
  TimeoutError,
  UnsupportedCapabilityError,
} from '../../public/errors.js';

export interface CodexDynamicToolContext {
  signal: AbortSignal;
  deadline?: number;
  scope?: Readonly<{ provider: string; transport: 'exec' | 'control'; cwd: string; sessionId: string; turnId?: string; callId?: string; authorityEpoch: string }>;

}

export interface CodexDynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  timeoutMs: number;
  maxOutputBytes: number;
  handler(input: unknown, context: CodexDynamicToolContext): Promise<unknown>;
}

interface RegisteredTool {
  definition: CodexDynamicToolDefinition;
  validate: ValidateFunction;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/**
 * Host for TypeScript tools exposed to Codex over the experimental dynamic
 * tool surface. Gated behind experimentalApi; input is schema-validated,
 * execution is bounded by timeoutMs and maxOutputBytes, and the registry
 * hashes deterministically so a resumed thread can prove it is being rebound
 * to the same tool set.
 */
export class CodexDynamicToolHost {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #hash: string;
  readonly #pending = new Map<string, number>();
  readonly #hasExternalPending: ((sessionId: string) => boolean) | undefined;

  constructor(options: { experimentalApi: boolean; tools: CodexDynamicToolDefinition[]; hasExternalPending?: (sessionId: string) => boolean }) {
    if (options.tools.length > 0 && !options.experimentalApi) {
      throw new UnsupportedCapabilityError(
        { provider: 'codex', transport: 'control', retryable: false },
        'Codex dynamic tools require experimentalApi: true',
      );
    }
    this.#hasExternalPending = options.hasExternalPending;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    for (const original of options.tools) {
      if (!Number.isInteger(original.timeoutMs) || original.timeoutMs < 1 || original.timeoutMs > 2 ** 31 - 1
        || !Number.isSafeInteger(original.maxOutputBytes) || original.maxOutputBytes < 1) throw new RangeError('Dynamic tool limits must be positive supported integers');
      const definition = Object.freeze({ ...original, inputSchema: structuredClone(original.inputSchema) });
      if (this.#tools.has(definition.name)) {
        throw new ProtocolError(
          { provider: 'codex', retryable: false },
          `Duplicate dynamic tool name: ${definition.name}`,
        );
      }
      this.#tools.set(definition.name, { definition, validate: ajv.compile(definition.inputSchema) });
    }
    this.#hash = createHash('sha256')
      .update(canonical(
        [...this.#tools.values()]
          .map(({ definition }) => ({
            name: definition.name,
            description: definition.description,
            inputSchema: definition.inputSchema,
            timeoutMs: definition.timeoutMs,
            maxOutputBytes: definition.maxOutputBytes,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ))
      .digest('hex');
  }

  get size(): number {
    return this.#tools.size;
  }

  hasPending(sessionId: string): boolean { return (this.#pending.get(sessionId) ?? 0) > 0 || this.#hasExternalPending?.(sessionId) === true; }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  registryHash(): string {
    return this.#hash;
  }

  wireDeclarations(): Array<{ name: string; description: string; inputSchema: object }> {
    return [...this.#tools.values()].map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: structuredClone(definition.inputSchema),
    }));
  }

  async call(name: string, input: unknown, context: CodexDynamicToolContext): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new ProtocolError(
        { provider: 'codex', transport: 'control', retryable: false },
        `Dynamic tool ${name} is not registered`,
      );
    }
    if (!tool.validate(input)) {
      throw new ProtocolError(
        {
          provider: 'codex',
          transport: 'control',
          retryable: false,
          sanitizedDiagnostics: { tool: name, validationErrors: tool.validate.errors ?? [] },
        },
        `Dynamic tool ${name} received input that fails its schema`,
      );
    }
    if (context.signal.aborted) {
      throw new AbortError({ provider: 'codex', retryable: false }, `Dynamic tool ${name} call was aborted`);
    }
    const result = await this.#withTimeout(tool.definition, input, context);
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8'); }
    catch { throw new ProtocolError({ provider: 'codex', retryable: false }, 'Dynamic tool output must be JSON serializable'); }
    if (bytes > tool.definition.maxOutputBytes) {
      throw new OutputLimitError(
        { provider: 'codex', retryable: false },
        `Dynamic tool ${name} output (${bytes} bytes) exceeds maxOutputBytes (${tool.definition.maxOutputBytes})`,
      );
    }
    return result;
  }

  async #withTimeout(
    definition: CodexDynamicToolDefinition,
    input: unknown,
    context: CodexDynamicToolContext,
  ): Promise<unknown> {
    if (context.deadline !== undefined && context.deadline <= Date.now()) throw new TimeoutError({ provider: 'codex', transport: 'control', retryable: false }, 'Dynamic tool deadline expired');
    const timeoutMs = Math.min(definition.timeoutMs, context.deadline === undefined ? definition.timeoutMs : Math.max(1, context.deadline - Date.now()));
    const scope = new OperationScope({ timeoutMs, signal: context.signal, context: { provider: 'codex', transport: 'control', retryable: false } });
    const sessionId = context.scope?.sessionId ?? '';
    try {
      return await scope.race(() => {
        const work = Promise.resolve(definition.handler(input, { ...context, signal: scope.signal, deadline: scope.deadline }));
        this.#pending.set(sessionId, (this.#pending.get(sessionId) ?? 0) + 1);
        const retire = () => {
          const count = (this.#pending.get(sessionId) ?? 1) - 1;
          if (count === 0) this.#pending.delete(sessionId); else this.#pending.set(sessionId, count);
        };
        void work.then(retire, retire);
        return work;
      });
    } finally { scope.dispose(); }
  }
}
