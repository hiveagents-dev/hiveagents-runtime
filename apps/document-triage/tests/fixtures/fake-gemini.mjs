import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.56.0'); process.exit(0); }
if (args.includes('--help')) {
  console.log(`Options:
  --prompt <text> Prompt
  --model <name> Model
  --output-format <format> Output
  --resume <session> Resume
  --admin-policy <path> Admin policy
  --approval-mode <mode> Approval mode
  --extensions <name> Extensions
  --settings <path> Settings
  --sandbox Sandbox`);
  process.exit(0);
}
const promptArgument = args.find(argument => argument.startsWith('--prompt='));
if (!promptArgument && !args.includes('--prompt')) throw new Error('Fixture only accepts explicit headless prompts');
const resume = args.indexOf('--resume');
const sessionId = resume < 0 ? '11111111-2222-4333-8444-555555555555' : args[resume + 1];
if (process.env.OAR_FIXTURE_CALLS) {
  appendFileSync(process.env.OAR_FIXTURE_CALLS, JSON.stringify({ args, cwd: process.cwd(), sessionId }) + '\n');
}
const prompt = promptArgument?.slice('--prompt='.length) ?? args[args.indexOf('--prompt') + 1] ?? '';
const category = /backup restauración/.test(prompt) ? 'backups' : 'network';
const content = JSON.stringify({ category, summary: category === 'backups' ? 'Verify backup restoration.' : 'Verify VPN access.' });
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'init', session_id: sessionId, model: 'gemini-2.5-flash' });
emit({ type: 'message', role: 'assistant', content: content.slice(0, 15), delta: true });
emit({ type: 'message', role: 'assistant', content: content.slice(15), delta: true });
emit({ type: 'result', status: 'success', stats: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } });
