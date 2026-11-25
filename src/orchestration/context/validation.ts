import { isAbsolute, normalize } from 'node:path';
import { closedRecord, integer } from '../budget/validation.ts';

export const MAX_CONSTRAINT_BYTES = 16 * 1024;
/** Small enough for every provider channel (Codex accepts 64 KiB per config entry). */
export const MAX_PINNED_BYTES = 48 * 1024;
export const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;

const NAME = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
// Everything below space except tab and newline, plus DEL, plus a surrogate without its pair.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]|\p{Cs}/u;

export function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** A scope or id: lowercase, no spaces, safe to print inside the pinned channel. */
export function name(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new TypeError(`${field} must match ${NAME.source}`);
  }
}

/** A primitive, well-formed string without control characters. Objects are never coerced. */
export function text(value: unknown, field: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (CONTROL.test(value)) {
    throw new TypeError(`${field} must be well-formed text without control characters`);
  }
  if (bytes(value) > maxBytes) {
    throw new TypeError(`${field} exceeds ${maxBytes} bytes`);
  }
}

/** A short single-line label such as who set a constraint. */
export function label(value: unknown, field: string): asserts value is string {
  text(value, field, 256);
  if (/[\n\t]/.test(value)) {
    throw new TypeError(`${field} must be a single line`);
  }
}

/** A message or reference id: one token, safe to print. */
export function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[\w.:-]{1,128}$/.test(value)) {
    throw new TypeError(`${field} must be 1 to 128 letters, digits, '.', ':', '_' or '-'`);
  }
}

/** Task material: any text an agent, a tool or a file produced. Only NUL and size are refused. */
export function material(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must be a non-empty string without NUL`);
  }
  if (bytes(value) > MAX_CONTEXT_BYTES) {
    throw new TypeError(`${field} exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }
}

export function version(value: unknown, field: string): asserts value is number {
  if (!integer(value)) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

export function closed(value: unknown, keys: readonly string[], optional: readonly string[], what: string): asserts value is Record<string, unknown> {
  if (!closedRecord(value, keys, optional)) {
    throw new TypeError(`${what} must be a plain object with exactly: ${keys.join(', ')}`);
  }
}

export function scopes(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new TypeError('scopes must list between 1 and 16 scopes');
  }
  value.forEach((scope) => name(scope, 'scope'));
  if (new Set(value).size !== value.length) {
    throw new TypeError('scopes must not repeat');
  }
}

export function databasePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) {
    throw new TypeError('databasePath must be an absolute normalized path');
  }
}

export function storeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError('storeId must be the id of a ConstraintStore');
  }
}
