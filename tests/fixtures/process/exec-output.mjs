import { once } from 'node:events';

const [provider, mode] = process.argv.slice(2);
if (mode === 'native-first-error') {
  process.stderr.write('fixture failure');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
async function line(value) {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain');
}
await line(provider === 'claude'
  ? { type: 'system', subtype: 'init', session_id: 'native-fixture' }
  : { type: 'thread.started', thread_id: 'native-fixture' });

if (mode === 'fanout') {
  await line({ type: 'assistant', message: { content: Array.from({ length: 1800 }, (_, i) =>
    ({ type: 'tool_use', id: `tool-${i}`, name: 'fixture', input: { index: i } })) } });
} else {
  const count = mode === 'large-terminal' ? 3200 : 1800;
  for (let i = 0; i < count; i++) {
    await line({ type: 'fixture-progress', index: i,
      ...(mode === 'large-terminal' ? { padding: 'x'.repeat(3000) } : {}) });
  }
}
if (provider === 'claude') {
  await line({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-fixture',
    result: 'done', usage: { input_tokens: 10, output_tokens: 2 } });
} else {
  await line({ type: 'item.completed', item: { id: 'final', type: 'agent_message', text: 'done' } });
  await line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
}
