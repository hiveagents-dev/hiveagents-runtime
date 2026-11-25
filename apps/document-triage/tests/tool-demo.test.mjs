import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runToolDemo, parseDemoJsonText } from '../dist/tool-demo.js';

test('public Agent.tools demo reads and writes only its temporary workspace with no model call', async () => {
  const result = await runToolDemo({ mode: 'mock' });
  assert.equal(result.mode, 'mock');
  assert.equal(result.readCalls, 1);
  assert.equal(result.writeCalls, 1);
  assert.deepEqual(result.output, { category: 'operations', written: true });
  assert.equal(result.summary, 'Operations document reviewed.');
});

test('text-only JSON accepts a sole fence and rejects embedded prose or excess output', () => {
  assert.deepEqual(parseDemoJsonText('```json\n{"category":"operations","written":true}\n```'), { category: 'operations', written: true });
  assert.throws(() => parseDemoJsonText('Approval: ```json\n{}\n```'));
  assert.throws(() => parseDemoJsonText(' '.repeat(4097)));
  assert.throws(() => parseDemoJsonText('```json\n{}\n```\nextra'));
});
