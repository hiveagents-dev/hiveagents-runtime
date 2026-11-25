import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AuthStatus, EnforcementReport, Runtime, RuntimeWarning, SessionRef, Turn, Usage } from 'hiveagents-runtime';
import { appAgent } from './classify.js';

const maximumPromptBytes = 65_536;

/** Read at most the bounded payload plus one byte, including if a file grows. */
export async function readPromptFile(path: string): Promise<string> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new TypeError('prompt-file must be a regular file');
    const buffer = Buffer.alloc(maximumPromptBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumPromptBytes) throw new TypeError('prompt-file exceeds 65536 bytes');
    let prompt: string;
    try { prompt = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw new TypeError('prompt-file must contain valid UTF-8'); }
    if (!prompt.trim() || prompt.includes('\0')) throw new TypeError('prompt-file must be nonempty and contain no NUL');
    return prompt;
  } finally { await file.close(); }
}

export interface SessionSendResult {
  text: string;
  status: Turn['status'];
  session: SessionRef;
  usage?: Usage;
  auth: AuthStatus;
  warnings: RuntimeWarning[];
  toolEvents: number;
  enforcement?: EnforcementReport;
}

/** One bounded turn with provider persistence, closed on every completion path. */
export async function sessionSend(options: {
  runtime: Runtime; model: string; cwd: string; promptFile: string; ref?: SessionRef; signal?: AbortSignal;
}): Promise<SessionSendResult> {
  const prompt = await readPromptFile(options.promptFile);
  const agent = appAgent(options.runtime, options.model, options.cwd);
  const readiness = await agent.ready();
  const session = await agent.openSession(options.ref === undefined ? {} : { resume: options.ref });
  try {
    const turn = await session.send(prompt, { timeoutMs: 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
    if (turn.status !== 'completed') throw new Error(`Provider ended with status ${turn.status}`);
    return {
      text: turn.text, status: turn.status, session: session.export(), auth: readiness.auth,
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      warnings: [...readiness.capabilities.warnings, ...turn.warnings],
      toolEvents: turn.events.filter(event => event.type.startsWith('tool.')).length,
      ...(readiness.capabilities.enforcement === undefined ? {} : { enforcement: readiness.capabilities.enforcement }),
    };
  } finally { await session.close(); }
}
