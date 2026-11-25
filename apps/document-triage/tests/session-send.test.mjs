import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Runtime } from 'hiveagents-runtime';
import { createGeminiCliProvider } from 'hiveagents-runtime';
import { sessionSend } from '../dist/session-send.js';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('session-send counts observable tool events without returning their inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'triage-tool-events-test-'));
  try {
    const fixture = join(directory, 'fake-tools.mjs');
    await writeFile(fixture, `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('0.56.0'); process.exit(0); }
      if (args.includes('--help')) {
        console.log('  --prompt <text>  Prompt\\n  --model <name>  Model\\n  --output-format <format>  Output\\n  --resume <session>  Resume\\n  --admin-policy <path>  Policy\\n  --approval-mode <mode>  Approval\\n  --extensions <name>  Extensions\\n  --settings <path>  Settings\\n  --sandbox  Sandbox');
        process.exit(0);
      }
      const emit = value => console.log(JSON.stringify(value));
      emit({type:'init',session_id:'11111111-2222-4333-8444-555555555555'});
      emit({type:'tool_use',tool_id:'read-1',tool_name:'read_file',parameters:{path:'private-fixture-path'}});
      emit({type:'tool_result',tool_id:'read-1',output:'private-fixture-output'});
      emit({type:'message',role:'assistant',content:'done',delta:true});
      emit({type:'result',status:'success'});
    `);
    const promptFile = join(directory, 'prompt.txt');
    await writeFile(promptFile, 'Return done.');
    const runtime = new Runtime({ providers: [createGeminiCliProvider({
      executable: { command: process.execPath, argsPrefix: [fixture] },
    })] });
    const result = await sessionSend({ runtime, model: 'gemini/gemini-2.5-flash', cwd: directory, promptFile });
    assert.equal(result.status, 'completed');
    assert.equal(result.toolEvents, 2);
    assert.equal(JSON.stringify(result).includes('private-fixture'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
