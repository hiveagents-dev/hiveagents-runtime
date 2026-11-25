import { isAbsolute } from 'node:path';
import type { SessionRef } from 'hiveagents-runtime';

export interface DocumentRecord { id: string; text: string }
export interface Classification { category: 'network' | 'backups' | 'other'; summary: string }

export function validateDocuments(value: unknown): DocumentRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new TypeError('documents must contain 1 to 100 records');
  }
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    const document = item as Partial<DocumentRecord> | null;
    if (!document || typeof document !== 'object' || typeof document.id !== 'string'
      || !document.id.trim() || document.id.length > 128 || ids.has(document.id)
      || typeof document.text !== 'string' || !document.text.trim() || document.text.length > 50_000) {
      throw new TypeError('documents require unique nonempty ids and bounded text');
    }
    ids.add(document.id);
    return { id: document.id, text: document.text };
  });
}

export function validateClassification(text: string): Classification {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError('classification must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('classification must be a JSON object');
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.category !== 'string' || !['network', 'backups', 'other'].includes(value.category)
    || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 10_000
    || Object.keys(value).some(key => key !== 'category' && key !== 'summary')) {
    throw new TypeError('classification requires category network/backups/other and a bounded summary');
  }
  return { category: value.category as Classification['category'], summary: value.summary };
}

export function validateSessionRef(value: unknown): SessionRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid session reference');
  const ref = value as Partial<SessionRef>;
  if (ref.schemaVersion !== 1 || typeof ref.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(ref.provider)
    || typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 1024
    || typeof ref.cwd !== 'string' || !isAbsolute(ref.cwd) || ref.transport !== 'exec'
    || ref.persistence !== 'provider' || typeof ref.createdAt !== 'string' || Number.isNaN(Date.parse(ref.createdAt))
    || (ref.model !== undefined && typeof ref.model !== 'string')) {
    throw new TypeError('Invalid session reference');
  }
  return ref as SessionRef;
}
