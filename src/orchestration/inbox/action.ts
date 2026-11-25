import { decisionHash } from '../decisions/binding.js';
import type { JsonValue } from '../workflow/types.js';
import type { ManagedEffectAssociation } from '../log/execution-types.js';
import { UNSEEN_CHARACTERS, resolveDisplayPath } from './display.js';
import type { InboxAction, InboxDisplayField, InboxJson, InboxJsonObject } from './types.js';

/** Largest stored action, as UTF-8 bytes of its canonical JSON. */
export const MAX_ACTION_BYTES = 65_536;
export const MAX_DISPLAY_FIELDS = 8;
const MAX_DEPTH = 32;
const MAX_LABEL_LENGTH = 48;
const MAX_PATH_SEGMENTS = 8;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/u;

/** Input that is not a valid request. The engine reports it as `invalid-input`. */
export class InboxInputError extends TypeError {}

function fail(message: string): never {
  throw new InboxInputError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A short single-line name: non-empty, no surrounding spaces, no control characters. */
export function inboxIdentifier(value: unknown, field: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || CONTROL.test(value)) {
    fail(`${field} must be a single-line name of at most ${maxLength} characters`);
  }
  return value;
}

function hex64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${field} must be a SHA-256 digest in lowercase hex`);
  return value;
}

function closed(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plainObject(value)) fail(`${field} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !(required.includes(key) || optional.includes(key))) fail(`${field} has an unknown field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key} is required`);
  }
  return value;
}

/**
 * A strict copy of a JSON value with object keys in sorted order, so two equal actions always
 * serialize to the same text. Anything JSON cannot hold is refused instead of dropped.
 */
export function canonicalJson(value: unknown, depth = 0): InboxJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') fail('Only JSON values are allowed');
  if (depth >= MAX_DEPTH) fail(`Values may nest at most ${MAX_DEPTH} levels`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) fail('Arrays must be plain and dense');
    return Object.freeze(value.map((entry) => canonicalJson(entry, depth + 1)));
  }
  if (!plainObject(value)) fail('Objects must be plain');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || key === '__proto__')) fail('Objects may only hold plain named values');
  const copy: Record<string, InboxJson> = {};
  for (const key of (keys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Objects may only hold plain named values');
    copy[key] = canonicalJson(descriptor.value, depth + 1);
  }
  return Object.freeze(copy);
}

/** The effect in the neutral log, checked field by field and tied to the same system. */
function captureEffect(value: unknown, systemId: string): ManagedEffectAssociation {
  const effect = closed(value, 'effect', ['identity', 'stepId', 'effectKey', 'operation'], ['parentEffectKey']);
  const identity = closed(effect.identity, 'effect.identity', ['systemId', 'generation', 'runId', 'agentId', 'harness']);
  if (identity.systemId !== systemId) fail('effect.identity.systemId must be the system that files the request');
  if (typeof identity.generation !== 'number' || !Number.isSafeInteger(identity.generation) || identity.generation < 0) {
    fail('effect.identity.generation must be a non-negative integer');
  }
  inboxIdentifier(identity.runId, 'effect.identity.runId');
  inboxIdentifier(identity.agentId, 'effect.identity.agentId');
  const harness = closed(identity.harness, 'effect.identity.harness', ['id', 'version', 'digest']);
  inboxIdentifier(harness.id, 'effect.identity.harness.id');
  inboxIdentifier(harness.version, 'effect.identity.harness.version');
  hex64(harness.digest, 'effect.identity.harness.digest');
  inboxIdentifier(effect.stepId, 'effect.stepId');
  inboxIdentifier(effect.effectKey, 'effect.effectKey');
  if (effect.parentEffectKey !== undefined) inboxIdentifier(effect.parentEffectKey, 'effect.parentEffectKey');
  const operation = closed(effect.operation, 'effect.operation', ['id', 'version', 'targetDigest', 'contentDigest'], ['provider', 'model']);
  inboxIdentifier(operation.id, 'effect.operation.id');
  inboxIdentifier(operation.version, 'effect.operation.version');
  hex64(operation.targetDigest, 'effect.operation.targetDigest');
  hex64(operation.contentDigest, 'effect.operation.contentDigest');
  if (operation.provider !== undefined) inboxIdentifier(operation.provider, 'effect.operation.provider');
  if (operation.model !== undefined) inboxIdentifier(operation.model, 'effect.operation.model');
  return value as ManagedEffectAssociation;
}

/** A validated action in its stored form: canonical object, its JSON text and its hash. */
export interface CapturedAction {
  readonly systemId: string;
  readonly actionKind: string;
  readonly payload: InboxJsonObject;
  readonly effect?: ManagedEffectAssociation;
  /** Exactly the text that is hashed and stored. */
  readonly json: string;
  readonly hash: string;
}

/**
 * Validates an action and binds it: the hash is `decisionHash` over the canonical action
 * `{ actionKind, effect, payload, systemId }`, with `effect: null` when there is none.
 * Throws `InboxInputError` for anything that is not a valid action.
 */
export function captureAction(action: unknown): CapturedAction {
  const input = closed(action, 'action', ['systemId', 'actionKind', 'payload'], ['effect']);
  const systemId = inboxIdentifier(input.systemId, 'systemId');
  const actionKind = inboxIdentifier(input.actionKind, 'actionKind');
  if (!plainObject(input.payload)) fail('payload must be a plain JSON object');
  const effect = input.effect === undefined ? null : captureEffect(input.effect, systemId);
  const canonical = canonicalJson({ systemId, actionKind, payload: input.payload, effect }) as {
    payload: InboxJsonObject;
    effect: InboxJson;
  };
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json, 'utf8') > MAX_ACTION_BYTES) fail(`An action may take at most ${MAX_ACTION_BYTES} bytes`);
  return {
    systemId,
    actionKind,
    payload: canonical.payload,
    ...(canonical.effect === null ? {} : { effect: canonical.effect as unknown as ManagedEffectAssociation }),
    json,
    hash: decisionHash(canonical as unknown as JsonValue),
  };
}

/**
 * The hash an approval is bound to. Two actions have the same hash only when the system, the
 * action kind, every payload value and the effect reference are all equal; key order is irrelevant.
 */
export function inboxActionHash(action: InboxAction): string {
  return captureAction(action).hash;
}

/** Reads a stored action back and proves it still matches the hash it was filed under. */
export function restoreAction(json: string, hash: string): CapturedAction | undefined {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const { effect, ...rest } = parsed;
    const captured = captureAction(effect === null ? rest : parsed);
    return captured.json === json && captured.hash === hash ? captured : undefined;
  } catch {
    return undefined;
  }
}

const UNSEEN = new RegExp(`[${UNSEEN_CHARACTERS}\\p{Zl}\\p{Zp}]`, 'u');
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Validates the card lines a system declares for one of its actions. A label is a short visible
 * name: one line, at most 48 characters, with a letter or digit and no invisible characters.
 */
export function declareDisplay(display: unknown, field: string): readonly InboxDisplayField[] {
  if (!Array.isArray(display) || display.length < 1 || display.length > MAX_DISPLAY_FIELDS) {
    fail(`${field} must hold between 1 and ${MAX_DISPLAY_FIELDS} lines`);
  }
  return Object.freeze(display.map((entry: unknown, index) => {
    const line = closed(entry, `${field}[${index}]`, ['label', 'path']);
    const label = inboxIdentifier(line.label, `${field}[${index}].label`, MAX_LABEL_LENGTH);
    if (UNSEEN.test(label) || !LETTER_OR_DIGIT.test(label)) fail(`${field}[${index}].label must be a visible name`);
    const path = line.path;
    if (!Array.isArray(path) || path.length < 1 || path.length > MAX_PATH_SEGMENTS
      || path.some((segment) => typeof segment !== 'string' || segment.length > 128)) {
      fail(`${field}[${index}].path must hold between 1 and ${MAX_PATH_SEGMENTS} keys`);
    }
    return Object.freeze({ label, path: Object.freeze([...(path as string[])]) });
  }));
}

/** The declared lines of an action, once every one of them finds its value in this payload. */
export function bindDisplay(display: readonly InboxDisplayField[], payload: InboxJsonObject): readonly InboxDisplayField[] {
  for (const line of display) {
    if (!resolveDisplayPath(payload, line.path).found) fail(`The payload has no value for the card line ${line.label}`);
  }
  return display;
}
