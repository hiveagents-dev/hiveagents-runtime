import { appendFileSync, readFileSync } from 'node:fs';
const provider = process.argv[2], args = process.argv.slice(3);
if (args.includes('--version')) { console.log(provider === 'codex' ? 'codex-cli 0.153.4' : '2.1.228 (Claude Code)'); process.exit(0); }
if (args.includes('--help')) {
  console.log(['--print','--output-format','--model','--session-id','--verbose','--resume','--fork-session','--json-schema',
    '--include-partial-messages','--safe-mode','--permission-mode','--effort','--tools','--strict-mcp-config','--system-prompt',
    '--json','--output-schema','--ignore-user-config','--ignore-rules','--sandbox','--config'].map(flag => `  ${flag} <value>`).join('\n') + '\n  permission-mode choices: plan, dontAsk, acceptEdits');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
const prompt = readFileSync(0, 'utf8');
if (!prompt) throw new Error('Expected explicit prompt on stdin');
const kind = prompt.includes('ARITHMETIC_TASK') ? 'arithmetic' : 'classification';
const drift = process.env.OAR_LEARNING_FIXTURE_MODE === 'drift';
const good = (kind === 'arithmetic' ? provider === 'codex' : provider === 'claude') !== drift;
let answer;
if (kind === 'arithmetic') {
  const values = JSON.parse(/VALUES: (\[[^\n]+\])/.exec(prompt)?.[1] ?? '[]');
  answer = values.reduce((a, b) => a + b, 0) + (good ? 0 : 1);
} else {
  const document = /DOCUMENT: ([\s\S]*)/.exec(prompt)?.[1] ?? '';
  const category = /backup|restore|respaldo|restaur|snapshot|rsync|recovery|recover|RPO|copia de seguridad/i.test(document) ? 'backups' : /\b(?:VPN|DNS|WAN|Wi-Fi|firewall|VLAN|proxy|switch|BGP|DHCP)\b/i.test(document) ? 'network' : 'other';
  answer = good ? category : category === 'other' ? 'network' : 'other';
}
const sessionIndex = args.indexOf('--session-id');
const model = args[args.indexOf('--model') + 1], id = sessionIndex >= 0 ? args[sessionIndex + 1] : '11111111-2222-4333-8444-555555555555';
if (process.env.OAR_LEARNING_CALLS) appendFileSync(process.env.OAR_LEARNING_CALLS, JSON.stringify({ provider, model, kind, drift }) + '\n');
const emit = value => console.log(JSON.stringify(value));
if (provider === 'claude') emit({ type: 'system', subtype: 'init', session_id: id, model, tools: [], permissionMode: 'plan' });
else { emit({ type: 'thread.started', thread_id: id }); emit({ type: 'turn.started' }); }
if (process.env.OAR_LEARNING_FIXTURE_MODE === 'wait') setInterval(() => {}, 1000);
else {
  const text = JSON.stringify({ answer });
  if (provider === 'claude') {
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: id });
    emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: id, usage: { input_tokens: 12, output_tokens: 4 } });
  } else {
    emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } });
    emit({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } });
  }
}
