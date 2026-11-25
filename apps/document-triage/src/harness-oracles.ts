import type { JsonValue } from 'hiveagents-runtime/orchestration';
import { validateClassification } from './validation.js';

export const DOCUMENT_SCORERS = [{
  id: 'classification-schema', version: '1',
  score(output: JsonValue) {
    try { validateClassification(JSON.stringify(output)); return { value: 1, passed: true, code: 'VALID_SCHEMA' }; }
    catch { return { value: 0, passed: false, code: 'INVALID_SCHEMA' }; }
  },
}, {
  id: 'expected-category', version: '1',
  score(output: JsonValue, expected: JsonValue) {
    const actual = output && typeof output === 'object' && !Array.isArray(output) ? output.category : undefined;
    const wanted = expected && typeof expected === 'object' && !Array.isArray(expected) ? expected.category : undefined;
    const passed = actual === wanted;
    return { value: Number(passed), passed, code: passed ? 'CATEGORY_MATCH' : 'CATEGORY_MISMATCH' };
  },
}, {
  id: 'summary-factual-anchor', version: '1',
  score(output: JsonValue, expected: JsonValue) {
    const summary = output && typeof output === 'object' && !Array.isArray(output) && typeof output.summary === 'string' ? output.summary.toLowerCase() : '';
    const anchors = expected && typeof expected === 'object' && !Array.isArray(expected) && Array.isArray(expected.anchors) ? expected.anchors : [];
    const passed = anchors.length > 0 && anchors.every(anchor => typeof anchor === 'string' && summary.includes(anchor.toLowerCase()));
    return { value: Number(passed), passed, code: passed ? 'ANCHORS_PRESENT' : 'MISSING_ANCHOR' };
  },
}];
