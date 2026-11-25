import type { InboxJson, InboxJsonObject } from './types.js';

// Pure: no Node imports, so the card and text helpers that build on it can run anywhere.

/**
 * Characters that change how neighbouring text is drawn without being visible themselves, as the
 * inside of a character class: every format character (direction overrides, isolates, zero-width
 * marks, soft hyphens) and the letters that draw as blank space.
 */
export const UNSEEN_CHARACTERS = '\\p{Cf}\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u2800\\u3164\\uffa0';

/** Follows a display path from the payload root. Only own keys and existing indexes resolve. */
export function resolveDisplayPath(payload: InboxJson, path: readonly string[]): { found: true; value: InboxJson } | { found: false } {
  let current: InboxJson = payload;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= current.length) return { found: false };
      current = current[Number(segment)] as InboxJson;
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as InboxJsonObject)[segment] as InboxJson;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
