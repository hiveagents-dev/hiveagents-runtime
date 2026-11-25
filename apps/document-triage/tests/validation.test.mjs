import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateClassification, validateDocuments, validateSessionRef } from '../dist/validation.js';
import { classificationPrompt } from '../dist/classify.js';

test('document data does not invoke native CLI resource preprocessing', () => {
  const text = 'Contact a@example.com and inspect @resource-uri ';
  const prompt = classificationPrompt(text);
  assert.equal(prompt.includes('@'), false);
  assert.equal(JSON.parse(prompt.slice(prompt.indexOf('{'))).notes, text);
});

test('application validates bounded documents before scheduling work', () => {
  assert.deepEqual(validateDocuments([{ id: 'vpn', text: 'VPN access' }]), [{ id: 'vpn', text: 'VPN access' }]);
  for (const value of [[], null, [{ id: '', text: 'x' }], [{ id: 'x', text: '' }],
    [{ id: 'x', text: 'x' }, { id: 'x', text: 'y' }], [{ id: 'x', text: 'a'.repeat(50_001) }]]) {
    assert.throws(() => validateDocuments(value), /documents/);
  }
});

test('application checks the model text rather than trusting a JSON shaped response', () => {
  assert.deepEqual(validateClassification('{"category":"network","summary":"Check VPN"}'),
    { category: 'network', summary: 'Check VPN' });
  for (const value of ['not JSON', '{}', '{"category":"unknown","summary":"x"}',
    '{"category":["network"],"summary":"x"}',
    '{"category":"network","summary":""}', '{"category":"network","summary":"x","execute":true}']) {
    assert.throws(() => validateClassification(value), /classification/);
  }
});

test('resume references must identify an absolute provider session', () => {
  const valid = { schemaVersion: 1, provider: 'gemini', id: 'opaque-session', cwd: '/tmp/project',
    transport: 'exec', persistence: 'provider', createdAt: '2026-11-08T00:00:00.000Z' };
  assert.deepEqual(validateSessionRef(valid), valid);
  for (const value of [null, { ...valid, cwd: '../project' }, { ...valid, id: '' },
    { ...valid, persistence: 'process' }, { ...valid, createdAt: 'invalid' }]) {
    assert.throws(() => validateSessionRef(value), /session reference/);
  }
});
