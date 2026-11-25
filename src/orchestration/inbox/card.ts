import { UNSEEN_CHARACTERS, resolveDisplayPath } from './display.js';
import type { InboxCard, InboxCardField, InboxDisplayField, InboxItem, InboxJson, InboxJsonObject } from './types.js';

/** Longest value a card line shows before it is cut. */
export const MAX_CARD_VALUE_LENGTH = 240;

// A value must not be able to restyle a card or look like an empty one.
const INVISIBLE = new RegExp(`[${UNSEEN_CHARACTERS}]`, 'gu');
const BREAKS_AND_CONTROLS = /[\s\x00-\x1f\x7f-\x9f]+/gu;

function plainText(text: string, maxLength: number): { text: string; cut: boolean } {
  const clean = text.replace(INVISIBLE, '').replace(BREAKS_AND_CONTROLS, ' ').trim();
  const characters = Array.from(clean);
  if (characters.length <= maxLength) return { text: clean, cut: false };
  return { text: `${characters.slice(0, maxLength - 1).join('')}…`, cut: true };
}

/** One line of plain text: no control or invisible characters, single spaces, bounded length. */
export function inboxPlainText(text: string, maxLength = MAX_CARD_VALUE_LENGTH): string {
  return plainText(text, maxLength).text;
}

function displayText(value: InboxJson): { text: string; cut: boolean } {
  if (value === null) return { text: '(vacío)', cut: false };
  if (typeof value === 'boolean') return { text: value ? 'sí' : 'no', cut: false };
  if (typeof value === 'number') return { text: String(value), cut: false };
  const shown = plainText(typeof value === 'string' ? value : JSON.stringify(value), MAX_CARD_VALUE_LENGTH);
  return shown.text.length === 0 ? { text: '(vacío)', cut: false } : shown;
}

/** How a payload value reads on a card. Text is data: it is cleaned and cut, never interpreted. */
export function inboxDisplayValue(value: InboxJson): string {
  return displayText(value).text;
}

/**
 * How many single values of the payload no line of the card covers. A line covers the value at its
 * exact path and everything inside it, and nothing beside it: a line that shows the first of 900
 * recipients leaves 899 uncovered. An empty list or group counts as one value.
 */
function countUncovered(value: InboxJson, path: string, covered: ReadonlySet<string>): number {
  if (covered.has(path)) return 0;
  if (value === null || typeof value !== 'object') return 1;
  const entries: [string, InboxJson][] = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry as InboxJson])
    : Object.entries(value as InboxJsonObject);
  if (entries.length === 0) return 1;
  let uncovered = 0;
  for (const [key, entry] of entries) uncovered += countUncovered(entry, `${path}/${JSON.stringify(key)}`, covered);
  return uncovered;
}

function pathKey(path: readonly string[]): string {
  return path.map((segment) => `/${JSON.stringify(segment)}`).join('');
}

/**
 * The lines of a card. Every value is read from the payload the approval is bound to, at the
 * place the display line names. `hiddenFields` counts every single value of the payload, at any
 * depth, that no line shows; `cutFields` counts the lines whose value did not fit and was cut.
 * Together they say how much of what is being approved the card leaves out.
 */
export function inboxCardFields(payload: InboxJsonObject, display: readonly InboxDisplayField[]): {
  fields: InboxCardField[];
  hiddenFields: number;
  cutFields: number;
} {
  const fields: InboxCardField[] = [];
  const covered = new Set<string>();
  let cutFields = 0;
  for (const line of display) {
    const resolved = resolveDisplayPath(payload, line.path);
    if (!resolved.found) continue;
    covered.add(pathKey(line.path));
    const shown = displayText(resolved.value);
    if (shown.cut) cutFields += 1;
    fields.push({ label: inboxPlainText(line.label), value: shown.text, ...(shown.cut ? { cut: true as const } : {}) });
  }
  return { fields, hiddenFields: countUncovered(payload, '', covered), cutFields };
}

/** The card of a stored request. A pure function of its structured fields; no model is involved. */
export function inboxCard(item: InboxItem): InboxCard {
  const { fields, hiddenFields, cutFields } = inboxCardFields(item.payload, item.display);
  const effect = item.effect;
  return {
    requestId: item.requestId,
    systemId: item.systemId,
    actionKind: item.actionKind,
    actionHash: item.actionHash,
    requestedAt: item.requestedAt,
    requestedBy: item.transitions[0]?.by ?? '',
    expiresAt: item.expiresAt,
    fields,
    hiddenFields,
    cutFields,
    ...(effect === undefined ? {} : { effect: { runId: effect.identity.runId, agentId: effect.identity.agentId, effectKey: effect.effectKey } }),
  };
}
