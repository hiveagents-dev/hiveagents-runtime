import { randomUUID } from 'node:crypto';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2), provider = args.shift(), send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (provider === 'claude') {
  const at = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session-id');
  const id = args.includes('--fork-session') ? `fixture-fork-${randomUUID()}` : args[at + 1] ?? 'fixture-claude';
  send({ type: 'system', subtype: 'init', session_id: id });
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'seeded-native-secret' } }, session_id: id });
  if (prompt.includes('slow')) await new Promise(r => setTimeout(r, 250));
  if (prompt.includes('hang')) await new Promise(() => setInterval(() => {}, 1000));
  send({ type: 'result', session_id: id, result: 'seeded-native-secret', is_error: false, usage: { input_tokens: 2, output_tokens: 3 } });
} else {
  send({ type: 'thread.started', thread_id: 'fixture-codex' }); send({ type: 'turn.started', turn_id: 'fixture-turn' });
  send({ type: 'item.completed', item: { id: 'fixture-message', type: 'agent_message', text: 'seeded-native-secret' } });
  if (prompt.includes('slow')) await new Promise(r => setTimeout(r, 250));
  if (prompt.includes('hang')) await new Promise(() => setInterval(() => {}, 1000));
  send({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } });
}
