import type { RecalledMemory } from './memory-types.js';

/**
 * The rules a recalled item must meet before the SDK carries it to a model. Pure and
 * dependency-free, so a memory adapter can apply the same rules before it counts an item
 * against its limit, instead of returning something the SDK would then drop.
 */

/** Longest id, source or title the SDK carries. */
export const MEMORY_LABEL_MAX = 256;
/** Longest `observedAt` the SDK carries. */
export const MEMORY_OBSERVED_AT_MAX = 64;

// C0 and C1 controls (every line break among them), the Unicode line and paragraph separators,
// lone surrogates, and format characters: zero-width, bidi overrides and the tag block that
// can carry text a model reads but a person reviewing the memory cannot see.
const UNSAFE_LABEL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}|\p{Cf}/u;
// Tag characters (U+E0000 to U+E007F) have no visible rendering anywhere; they are removed from text.
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
// id and source sit between square brackets on the SDK-owned item header. Any opening or closing
// punctuation (ASCII brackets, parentheses and braces, and look-alikes such as fullwidth, white,
// lenticular or tortoise-shell brackets), checked after NFKC folds compatibility forms, could
// pass for the end of a field or the start of another one, so it drops the item.
// Opening and closing punctuation, plus the bracket pieces of the math symbols block (⎡⎢⎣⎤⎥⎦⎴⎵),
// which are Sm and survive NFKC but read as square brackets.
const BRACKETS = /[\p{Ps}\p{Pe}\u23A1-\u23A6\u23B4\u23B5]/u;
// Strict ISO-8601 date and time with an explicit offset; the lenient Date.parse forms (with
// "(comments)", or text before the date) never reach the header.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A non-empty single-line label of at most `max` characters with no control or invisible format character. */
export function isMemoryLabel(value: unknown, max = MEMORY_LABEL_MAX): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !UNSAFE_LABEL.test(value);
}

function bracketed(value: string): boolean { return BRACKETS.test(value.normalize('NFKC')); }

/**
 * A label that may sit between square brackets on an SDK-owned header (an item's id and source,
 * the profile's source, which is the provider's id): a memory label with no opening or closing
 * punctuation after NFKC.
 */
export function isMemoryHeaderLabel(value: unknown, max = MEMORY_LABEL_MAX): value is string {
  return isMemoryLabel(value, max) && !bracketed(value);
}

/** `observedAt` as the header carries it (`Date.prototype.toISOString`), or undefined when it is not strict ISO-8601. */
function instant(value: string): string | undefined {
  if (!ISO_8601.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/**
 * A scope profile as the SDK will carry it, or undefined when it is unusable: not a string,
 * containing NUL, or empty or only whitespace once tag characters are removed. Tag characters
 * are removed; nothing else changes (every line is indented under the profile header when rendered).
 */
export function profileText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const visible = value.replace(TAGS, '');
  return visible.trim().length === 0 ? undefined : visible;
}

/**
 * The item as the SDK will carry it, or undefined when it must be dropped. An unusable title is
 * left out rather than dropping the item; an unusable id, source, observedAt or text drops it.
 * Tag characters are removed from the text; the text must still have something visible.
 * `observedAt` is carried normalized to `toISOString()` (UTC, milliseconds).
 */
export function recallableMemory(value: unknown): RecalledMemory | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, text, title, source, observedAt } = value as Partial<Record<keyof RecalledMemory, unknown>>;
  // id and source sit on the SDK-owned header between brackets: a bracket in them could forge a field.
  if (!isMemoryHeaderLabel(id) || !isMemoryHeaderLabel(source)) return undefined;
  const observed = typeof observedAt === 'string' && observedAt.length <= MEMORY_OBSERVED_AT_MAX ? instant(observedAt) : undefined;
  if (observedAt !== undefined && observed === undefined) return undefined;
  // The text follows the profile's rules: a string without NUL, with something visible once tags are removed.
  const visible = profileText(text);
  if (visible === undefined) return undefined;
  return {
    id, text: visible, source,
    ...(isMemoryLabel(title) ? { title } : {}),
    ...(observed === undefined ? {} : { observedAt: observed }),
  };
}
