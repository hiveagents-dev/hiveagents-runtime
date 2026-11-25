import { checksum, jsonClone, nonempty } from '../workflow/checkpoint.js';
import type { JsonValue } from '../workflow/types.js';
import type { DecisionBinding } from './types.js';

export const decisionHash = (value: JsonValue): string => checksum(JSON.stringify(jsonClone(value)));

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot app inputs; authority stays private and only its identity is persisted. */
export function bindDecision(options: {
  input: JsonValue; authority: JsonValue; inputVersion: string; authorityVersion: string;
}): DecisionBinding {
  nonempty(options.inputVersion, 'Input version'); nonempty(options.authorityVersion, 'Authority version');
  const input = jsonClone(options.input);
  return freeze({ input, inputHash: decisionHash(input), authorityHash: decisionHash(options.authority),
    inputVersion: options.inputVersion, authorityVersion: options.authorityVersion });
}

export function sameDecisionBinding(left: Omit<DecisionBinding, 'input'>, right: Omit<DecisionBinding, 'input'>): boolean {
  return left.inputHash === right.inputHash && left.authorityHash === right.authorityHash
    && left.inputVersion === right.inputVersion && left.authorityVersion === right.authorityVersion;
}

export function snapshotBinding(value: DecisionBinding): DecisionBinding {
  nonempty(value.inputVersion, 'Input version'); nonempty(value.authorityVersion, 'Authority version');
  if (decisionHash(value.input) !== value.inputHash || !/^[a-f0-9]{64}$/.test(value.authorityHash)) throw new Error('Invalid decision binding');
  return freeze(jsonClone(value));
}
