import process from 'node:process';

import { Agent } from '../../dist/index.js';

let input = '';
for await (const chunk of process.stdin) input += chunk.toString('utf8');
const { options, ref, prompt } = JSON.parse(input);
const session = await new Agent(options).openSession({ resume: ref });
const turn = await session.send(prompt);
process.stdout.write(JSON.stringify({
  text: turn.text,
  sessionId: turn.session.id,
  warningCodes: turn.warnings.map(({ code }) => code),
}));
