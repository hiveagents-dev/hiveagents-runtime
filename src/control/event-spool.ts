import { mkdtemp, open, realpath, rm, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { types } from 'node:util';
import { AgentRuntimeError, OutputLimitError, type ErrorContext } from '../public/errors.js';

const MB = 1024 * 1024;
export interface EventSpoolOptions {
  directory: string; maxUnreadBytes?: number; maxUnreadItems?: number; segmentBytes?: number;
  context?: ErrorContext; onFailure?: (error: AgentRuntimeError) => void;
}
function protocol(message: string, context: ErrorContext, cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError('PROTOCOL_ERROR', message, context, { cause });
}
/** Bounded JSON encoding without invoking getters/toJSON or expanding shared graphs. */
function encode(value: unknown, maximum: number, context: ErrorContext, collect: boolean, signals = false): { bytes: number; json: string } {
  let bytes = 0, nodes = 0; const parts: string[] = [], seen = new Set<object>();
  const add = (part: string) => {
    bytes += Buffer.byteLength(part, 'utf8');
    if (bytes > maximum) throw new OutputLimitError(context, 'Control event buffer exceeded its byte limit');
    if (collect) parts.push(part);
  };
  const string = (text: string) => {
    add('"');
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16_384, text.length);
      if (end < text.length && /[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
      add(JSON.stringify(text.slice(start, end)).slice(1, -1)); start = end;
    }
    add('"');
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 131_072 || depth > 64) throw new OutputLimitError(context, 'Control event structure exceeded its limit');
    if (item === null) { add('null'); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) { add(String(item)); return; }
    if (!item || typeof item !== 'object' || types.isProxy(item)) throw protocol('Control event is not JSON data', context);
    if (signals && item instanceof AbortSignal) { add('null'); return; }
    if (seen.has(item)) throw protocol('Control event contains a cycle or shared object graph', context); seen.add(item);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) throw protocol('Control event is not plain JSON data', context);
    const keys = Reflect.ownKeys(item);
    if (keys.length > 131_072) throw new OutputLimitError(context, 'Control event structure exceeded its limit');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) throw protocol('Control event contains an accessor', context);
    if (array) {
      if (keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/u.test(String(key)))) throw protocol('Control event has non-JSON array properties', context);
      add('['); for (let index = 0; index < item.length; index++) { if (index) add(','); visit(descriptors[String(index)]?.value ?? null, depth + 1); } add(']');
    } else {
      add('{'); let count = 0;
      for (const key of keys as string[]) { const data = descriptors[key]!.value; if (data === undefined) continue;
        if (count++) add(','); string(key); add(':'); visit(data, depth + 1); }
      add('}');
    }
  };
  visit(value, 0); return { bytes, json: parts.join('') };
}

/** Temporary transport storage only. One producer writer and one consumer; no restart/replay API. */
export class EventSpool<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #maximum: number; readonly #items: number; readonly #segment: number; readonly #context: ErrorContext;
  readonly #onFailure: EventSpoolOptions['onFailure'];
  #pending: Array<Buffer | undefined> = []; #head = 0; #unreadBytes = 0; #unreadItems = 0;
  #written = 0; #read = 0; #segments = 0; #writerHandle: FileHandle | undefined; #readerHandle: FileHandle | undefined;
  #readAhead: Buffer | undefined; #aheadOffset = 0;
  #writer: Promise<void> | undefined; #readIO: Promise<unknown> | undefined; #wake: (() => void) | undefined;
  #ended = false; #disposed = false; #busy = false; #failure: AgentRuntimeError | undefined; #disposing: Promise<void> | undefined;
  readonly #directory: string;
  constructor(directory: string, options: EventSpoolOptions) {
    this.#directory = directory;
    this.#maximum = options.maxUnreadBytes ?? 16 * MB; this.#items = options.maxUnreadItems ?? 65_536;
    this.#segment = options.segmentBytes ?? MB; this.#context = { ...options.context, retryable: false }; this.#onFailure = options.onFailure; Object.freeze(this);
  }
  get directory(): string { return this.#directory; }
  get stats() { return { unreadItems: this.#unreadItems, unreadBytes: this.#unreadBytes, pendingWrites: this.#writer ? 1 : 0, liveSegments: this.#segments }; }
  #file(position: number): string { return join(this.#directory, `${Math.floor(position / this.#segment)}.segment`); }
  #notify(): void { const wake = this.#wake; this.#wake = undefined; wake?.(); }
  append(value: T): void {
    if (this.#failure) throw this.#failure;
    if (this.#ended || this.#disposed) throw protocol('Control event buffer is closed', this.#context);
    try {
      if (this.#unreadItems >= this.#items) throw new OutputLimitError(this.#context, 'Control event buffer exceeded its item limit');
      const encoded = encode(value, this.#maximum - 4, this.#context, true), size = encoded.bytes + 4;
      if (this.#unreadBytes + size > this.#maximum) throw new OutputLimitError(this.#context, 'Control event buffer exceeded its byte limit');
      const frame = Buffer.allocUnsafe(size); frame.writeUInt32BE(encoded.bytes); frame.write(encoded.json, 4, 'utf8');
      this.#unreadBytes += size; this.#unreadItems++; this.#pending.push(frame); this.#startWriter();
    } catch (cause) { this.fail(cause); throw this.#failure; }
  }
  #startWriter(): void {
    if (this.#writer || this.#disposed) return;
    this.#writer = this.#drain().catch(cause => this.fail(cause instanceof AgentRuntimeError ? cause : protocol('Control event spool write failed', this.#context, cause)))
      .finally(() => { this.#writer = undefined; this.#notify(); if (this.#head < this.#pending.length) this.#startWriter(); });
  }
  async #drain(): Promise<void> {
    while (!this.#disposed && this.#head < this.#pending.length) {
      const frame = this.#pending[this.#head]!;
      for (let offset = 0; !this.#disposed && offset < frame.length;) {
        if (!this.#writerHandle) {
          if (this.#segments >= 256) throw new OutputLimitError(this.#context, 'Control event spool exceeded its live segment limit');
          this.#segments++; // Count an in-progress creation until disposal if open fails.
          this.#writerHandle = await open(this.#file(this.#written), 'wx', 0o600);
        }
        if (this.#disposed) return;
        const count = Math.min(frame.length - offset, this.#segment - this.#written % this.#segment);
        const result = await this.#writerHandle.write(frame, offset, count, this.#written % this.#segment);
        if (!result.bytesWritten) throw new Error('Spool write made no progress');
        const next = this.#written + result.bytesWritten;
        if (!Number.isSafeInteger(next)) throw new OutputLimitError(this.#context, 'Control event spool position exceeded its limit');
        if (next % this.#segment === 0) { await this.#writerHandle.close(); this.#writerHandle = undefined; }
        this.#written = next; offset += result.bytesWritten; this.#notify();
      }
      this.#pending[this.#head] = undefined; this.#head++;
      if (this.#head > 1024 && this.#head * 2 > this.#pending.length) { this.#pending = this.#pending.slice(this.#head); this.#head = 0; }
    }
    if (!this.#disposed) { this.#pending = []; this.#head = 0; }
  }
  async #readBytes(count: number): Promise<Buffer> {
    while (this.#written - this.#read < count) {
      if (this.#failure) throw this.#failure;
      if (this.#disposed) throw protocol('Control event buffer was disposed', this.#context);
      if (this.#ended && !this.#writer) throw protocol('Control event spool ended with an incomplete frame', this.#context);
      await new Promise<void>(resolve => { this.#wake = resolve; });
    }
    const buffer = Buffer.allocUnsafe(count);
    for (let offset = 0; offset < count;) {
      if (this.#disposed) throw protocol('Control event buffer was disposed', this.#context);
      if (!this.#readerHandle) {
        const opening = open(this.#file(this.#read), 'r'); this.#readIO = opening;
        this.#readerHandle = await opening; this.#readIO = undefined;
      }
      if (this.#disposed) throw protocol('Control event buffer was disposed', this.#context);
      const file = this.#file(this.#read);
      if (!this.#readAhead) {
        // A fixed read-ahead window avoids two syscalls per tiny JSON event.
        const length = Math.min(65_536, this.#written - this.#read, this.#segment - this.#read % this.#segment);
        const ahead = Buffer.allocUnsafe(length);
        const reading = this.#readerHandle.read(ahead, 0, length, this.#read % this.#segment); this.#readIO = reading;
        const result = await reading; this.#readIO = undefined;
        if (!result.bytesRead) throw protocol('Control event spool frame was truncated', this.#context);
        this.#readAhead = ahead.subarray(0, result.bytesRead); this.#aheadOffset = 0;
      }
      const copied = Math.min(count - offset, this.#readAhead.length - this.#aheadOffset);
      this.#readAhead.copy(buffer, offset, this.#aheadOffset, this.#aheadOffset + copied);
      this.#read += copied; offset += copied; this.#aheadOffset += copied;
      if (this.#aheadOffset === this.#readAhead.length) { this.#readAhead = undefined; this.#aheadOffset = 0; }
      if (this.#read % this.#segment === 0) { await this.#readerHandle.close(); this.#readerHandle = undefined; await unlink(file); this.#segments--; }
    }
    return buffer;
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.#failure) throw this.#failure;
    if (this.#disposed) return { done: true, value: undefined };
    if (this.#busy) throw protocol('Control event spool permits only one pending reader', this.#context);
    this.#busy = true;
    try {
      while (!this.#unreadItems && !this.#ended && !this.#disposed && !this.#failure) await new Promise<void>(resolve => { this.#wake = resolve; });
      if (this.#failure) throw this.#failure;
      if (this.#disposed || !this.#unreadItems) { await this.dispose(); return { done: true, value: undefined }; }
      const length = (await this.#readBytes(4)).readUInt32BE();
      if (length > this.#maximum - 4) throw protocol('Control event spool frame exceeds its bound', this.#context);
      const value = JSON.parse((await this.#readBytes(length)).toString('utf8')) as T;
      this.#unreadBytes -= length + 4; this.#unreadItems--; return { done: false, value };
    } catch (cause) {
      if (this.#disposed && !this.#failure) return { done: true, value: undefined };
      this.fail(cause); throw this.#failure;
    } finally { this.#busy = false; }
  }
  close(): void { this.#ended = true; this.#notify(); if (!this.#unreadItems) void this.dispose().catch(() => undefined); }
  fail(cause: unknown): void {
    if (this.#failure) return;
    this.#failure = cause instanceof AgentRuntimeError ? cause : protocol('Control event spool failed', this.#context, cause);
    this.#ended = true; this.#notify();
    try { this.#onFailure?.(this.#failure); } catch { /* Observer failure never replaces the first transport error. */ }
    void this.dispose().catch(() => undefined);
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#disposed = true; this.#ended = true; this.#pending = []; this.#head = 0; this.#notify();
    this.#disposing = Promise.resolve().then(async () => {
      await this.#writer; await this.#readIO?.catch(() => undefined);
      await this.#writerHandle?.close(); this.#writerHandle = undefined;
      await this.#readerHandle?.close(); this.#readerHandle = undefined;
      this.#readAhead = undefined; this.#aheadOffset = 0;
      await rm(this.#directory, { recursive: true, force: true }); this.#unreadBytes = 0; this.#unreadItems = 0; this.#segments = 0;
    }).catch(cause => { this.fail(protocol('Control event spool cleanup failed', this.#context, cause)); throw this.#failure; });
    return this.#disposing;
  }
  async return(): Promise<IteratorResult<T>> { await this.dispose(); return { done: true, value: undefined }; }
  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }
}
export async function createEventSpool<T>(options: EventSpoolOptions): Promise<EventSpool<T>> {
  if (types.isProxy(options)) throw new TypeError('Spool options must be data properties');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if ( Reflect.ownKeys(options).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) throw new TypeError('Spool options must be data properties');
  const captured = { ...options };
  if (typeof captured.directory !== 'string' || !isAbsolute(captured.directory) || captured.directory.includes('\0')) throw new TypeError('Spool directory must be absolute');
  for (const [value, maximum] of [[captured.maxUnreadBytes ?? 16 * MB, 256 * MB], [captured.maxUnreadItems ?? 65_536, 131_072], [captured.segmentBytes ?? MB, MB]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new RangeError('Invalid control spool bound');
  }
  try { return new EventSpool<T>(await realpath(await mkdtemp(join(captured.directory, 'oar-control-'))), captured); }
  catch (cause) { throw protocol('Cannot create private control event spool', { ...captured.context, retryable: false }, cause); }
}

export interface ControlBufferLimits {
  directory?: string; maxPublicBytes?: number; maxPublicItems?: number; maxCriticalBytes?: number; maxCriticalItems?: number; segmentBytes?: number;
}
interface ControlBufferOptions<T> extends ControlBufferLimits {
  epoch: string; isCritical(value: T): boolean; context?: ErrorContext; onFailure?(error: AgentRuntimeError): void;
}
type ControlRecord<T> = { epoch: string; bytes: number } & ({ lane: 'public'; value: T } | { lane: 'critical'; id: number });
/** Ordered JSON progress plus a separately bounded lane for live critical capabilities. */
export class ControlBuffer<T> implements AsyncIterator<T>, AsyncIterable<T> {
  readonly #live = new Map<number, { value: T; bytes: number }>();
  #publicBytes = 0; #publicItems = 0; #criticalBytes = 0; #id = 0; #closed = false;
  #failure: AgentRuntimeError | undefined;
  readonly #spool: EventSpool<ControlRecord<T>>; readonly #options: ControlBufferOptions<T>;
  constructor(spool: EventSpool<ControlRecord<T>>, options: ControlBufferOptions<T>) { this.#spool = spool; this.#options = Object.freeze(options); Object.freeze(this); }
  get failure(): AgentRuntimeError | undefined { return this.#failure; }
  push(value: T): boolean {
    if (this.#closed || this.#failure) return false;
    const context = { ...this.#options.context, retryable: false };
    try {
      const critical = this.#options.isCritical(value), maximum = critical ? this.#options.maxCriticalBytes! : this.#options.maxPublicBytes!;
      const bytes = encode(value, maximum - 256, context, false, critical).bytes + 256;
      if (critical) {
        if (this.#live.size >= this.#options.maxCriticalItems! || this.#criticalBytes + bytes > maximum) throw new OutputLimitError(context, 'Control critical lane exceeded its bound');
        if (!Number.isSafeInteger(++this.#id)) throw new OutputLimitError(context, 'Control reference identity exceeded its bound');
        this.#live.set(this.#id, { value, bytes }); this.#criticalBytes += bytes;
        this.#spool.append({ lane: 'critical', id: this.#id, bytes, epoch: this.#options.epoch });
      } else {
        if (this.#publicItems >= this.#options.maxPublicItems! || this.#publicBytes + bytes > maximum) throw new OutputLimitError(context, 'Control public lane exceeded its bound');
        this.#spool.append({ lane: 'public', value, bytes, epoch: this.#options.epoch }); this.#publicBytes += bytes; this.#publicItems++;
      }
      return true;
    } catch (cause) { this.fail(cause); return false; }
  }
  async next(): Promise<IteratorResult<T>> {
    if (this.#failure) throw this.#failure;
    try {
      const next = await this.#spool.next();
      if (next.done) {
        if (this.#live.size) throw protocol('Control buffer ended with missing critical references', { ...this.#options.context, retryable: false });
        return { done: true, value: undefined };
      }
      const item = next.value;
      if (item.epoch !== this.#options.epoch) throw protocol('Control buffer epoch does not match', { ...this.#options.context, retryable: false });
      if (item.lane === 'critical') {
        const live = this.#live.get(item.id);
        if (!live) throw protocol('Control buffer critical reference is missing', { ...this.#options.context, retryable: false });
        this.#live.delete(item.id); this.#criticalBytes -= live.bytes; return { done: false, value: live.value };
      }
      this.#publicBytes -= item.bytes; this.#publicItems--; return { done: false, value: item.value };
    } catch (cause) { this.fail(cause); throw this.#failure; }
  }
  close(): void { this.#closed = true; this.#spool.close(); }
  fail(cause: unknown): void {
    if (this.#failure) return;
    this.#failure = cause instanceof AgentRuntimeError ? cause : protocol(`Control delivery failed${cause instanceof Error ? `: ${cause.message}` : ''}`, { ...this.#options.context, retryable: false }, cause);
    this.#closed = true; this.#spool.fail(this.#failure); this.#live.clear(); this.#criticalBytes = 0;
    try { this.#options.onFailure?.(this.#failure); } catch { /* The first failure remains authoritative. */ }
  }
  async dispose(): Promise<void> { this.#closed = true; this.#live.clear(); this.#criticalBytes = 0; await this.#spool.dispose(); }
  async return(): Promise<IteratorResult<T>> { await this.dispose(); return { done: true, value: undefined }; }
  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }
}
export async function createControlBuffer<T>(options: ControlBufferOptions<T>): Promise<ControlBuffer<T>> {
  if (types.isProxy(options) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value'))) throw new TypeError('Control buffer options must be data properties');
  const captured = { ...options, context: Object.freeze({ ...options.context, retryable: false }),
    maxPublicBytes: options.maxPublicBytes ?? 16 * MB, maxPublicItems: options.maxPublicItems ?? 65_536,
    maxCriticalBytes: options.maxCriticalBytes ?? 64 * MB, maxCriticalItems: options.maxCriticalItems ?? 4096 };
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(captured.epoch) || typeof captured.isCritical !== 'function') throw new TypeError('Invalid control buffer identity');
  for (const [value, maximum] of [[captured.maxPublicBytes, 16 * MB], [captured.maxPublicItems, 65_536], [captured.maxCriticalBytes, 64 * MB], [captured.maxCriticalItems, 4096]]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) throw new RangeError('Invalid control buffer bound');
  }
  let buffer: ControlBuffer<T> | undefined;
  const spool = await createEventSpool<ControlRecord<T>>({ directory: captured.directory ?? tmpdir(),
    maxUnreadBytes: captured.maxPublicBytes + captured.maxCriticalItems * 256, maxUnreadItems: captured.maxPublicItems + captured.maxCriticalItems,
    ...(captured.segmentBytes === undefined ? {} : { segmentBytes: captured.segmentBytes }), context: captured.context, onFailure: error => buffer?.fail(error) });
  buffer = new ControlBuffer(spool, captured); return buffer;
}
