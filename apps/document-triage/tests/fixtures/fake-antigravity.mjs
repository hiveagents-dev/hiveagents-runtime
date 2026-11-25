import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Antigravity CLI version 1.5.3'); process.exit(0); }
if (args.includes('--help')) {
  console.error(`Usage: antigravity [flags]
Flags:
  -p, --print string           Print response and exit
      --model string           Model ID
      --output-format string   Output format
      --print-timeout duration Print deadline
      --conversation string    Resume conversation
      --settings string        Settings JSON
      --disable-slash-commands Disable slash commands`);
  process.exit(0);
}
const prompt = args.find(argument => argument.startsWith('--print='))?.slice('--print='.length);
if (prompt === undefined) throw new Error('Fixture requires one literal --print prompt');
if (!args.includes('--disable-slash-commands') || args.includes('--mode')) throw new Error('Unexpected native policy');
const settingIndex = args.indexOf('--settings');
if (settingIndex < 0) throw new Error('Fixture requires settings');
const settings = JSON.parse(args[settingIndex + 1]);
if (!JSON.stringify(settings).includes('request-review')) throw new Error('Fixture requires request-review');
const resume = args.indexOf('--conversation');
const sessionId = resume < 0 ? '11111111-2222-4333-8444-555555555555' : args[resume + 1];
const model = args[args.indexOf('--model') + 1];
if (process.env.OAR_FIXTURE_CALLS) {
  appendFileSync(process.env.OAR_FIXTURE_CALLS, JSON.stringify({ args, cwd: process.cwd(), sessionId, prompt }) + '\n');
}
const statePath = join(process.cwd(), '.fake-antigravity-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
let text;
if (prompt.startsWith('MEMORIZE ')) {
  state[sessionId] = prompt.slice('MEMORIZE '.length);
  writeFileSync(statePath, JSON.stringify(state));
  text = 'saved';
} else if (prompt === 'Return the stored nonce.') {
  if (resume < 0 || !state[sessionId]) throw new Error('Conversation state was not resumed');
  text = state[sessionId];
} else if (/Classify|classification/.test(prompt)) {
  const category = /backup restauración/.test(prompt) ? 'backups' : 'network';
  text = JSON.stringify({ category, summary: `Verify ${category}.` });
} else { text = `literal:${prompt}`; }
const emit = value => console.log(JSON.stringify(value));
emit({ event: 'init', conversation_id: sessionId,
  init: { model, cwd: process.cwd(), tools: [], permission_mode: 'request-review' } });
if (process.env.OAR_ANTIGRAVITY_FIXTURE_MODE === 'wait') setInterval(() => {}, 1000);
else {
  emit({ event: 'step_update', step_update: { conversation_id: sessionId, step_index: 1,
    state: 'ACTIVE', step_type: 'agent_response', text_delta: text.slice(0, 3) } });
  emit({ event: 'step_update', step_update: { conversation_id: sessionId, step_index: 1,
    state: 'DONE', step_type: 'agent_response', text_delta: text.slice(3) } });
  emit({ event: 'result', result: { conversation_id: sessionId,
    status: process.env.OAR_ANTIGRAVITY_FIXTURE_MODE === 'failure' ? 'ERROR' : 'SUCCESS',
    ...(process.env.OAR_ANTIGRAVITY_FIXTURE_MODE === 'failure' ? { error: { type: 'FIXTURE_ERROR' } } : {}),
    response: text, num_turns: resume < 0 ? 1 : 2,
    usage: { input_tokens: resume < 0 ? 8 : 16, output_tokens: resume < 0 ? 2 : 4 } } });
}
