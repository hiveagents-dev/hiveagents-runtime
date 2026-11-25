import { readFile, realpath, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { doctor, type LaunchTarget } from 'hiveagents-runtime';
import { classifyOne, resumeSession } from './classify.js';
import { createAppRuntime } from './runtime.js';
import { runDocumentTriage } from './triage.js';
import { sessionSend } from './session-send.js';
import { validateSessionRef } from './validation.js';
import { runDecisionGatedTriage, validateTriageAuthority } from './decision-triage.js';
import { runToolDemo } from './tool-demo.js';
import { evaluateDocuments, compareDocumentEvaluations, inspectDocumentTrace } from './harness-evaluation.js';
import { produceDocumentHandoff, consumeDocumentHandoff, documentHandoffStatus } from './harness-handoff.js';
import { positiveInteger } from './harness-common.js';
import { selectDocumentAgent, classifyWithSelectedAgent, inspectDocumentRouting } from './routing-agent.js';
import { inspectLearning, runLearningCycle, runLearningInput } from './learning-commands.js';
import { studyStatus, studyCycle, studyRun } from './learning-study-commands.js';
import { readStudyJsonFile } from './learning-study-session.js';
import { loggedCommand } from './logged-commands.js';

const usage = `Document triage (JSON input: [{"id":"vpn","text":"VPN notes"}])
  doctor
  log-run --input <path> --state-dir <path> --run-id <id>
  log-inspect|log-rebuild|log-handoff|log-reconcile --state-dir <path> --run-id <id>
  study-cycle --corpus <corpus.json> --config <agent.json> --state-dir <path> --max-launches <n> [--cycles <n>] [--batch-id <id>] [--operation promote|rollback] [--objective quality|latency|cost] [--timeout-ms <n>] [--cwd <path>] [--total-launches <n>]
  study-run --corpus <corpus.json> --config <agent.json> --state-dir <path> --input <task.json> --max-launches <n> [--auto-improve] [--cycles <n>] [--objective quality|latency|cost] [--timeout-ms <n>] [--cwd <path>] [--total-launches <n>]
  study-status --corpus <corpus.json> --config <agent.json> --state-dir <path> [--objective quality|latency|cost] [--timeout-ms <n>] [--cwd <path>]
  learn-matrix (alias of learn-cycle; same bounded measurement and policy gate)
  learn-cycle --config <agent.json> --state-dir <path> --max-launches <n> [--suite mixed|document] [--operation promote|rollback] [--objective quality|latency|cost] [--total-launches <n>] [--timeout-ms <n>] [--cwd <path>]
  learn-run --config <agent.json> --state-dir <path> --input <task.json> --max-launches <n> [--auto-improve] [--suite mixed|document] [--objective quality|latency|cost] [--total-launches <n>] [--timeout-ms <n>] [--cwd <path>]
  learn-status --config <agent.json> --state-dir <path> [--suite mixed|document] [--objective quality|latency|cost] [--timeout-ms <n>]
  route-select --config <agent.json> --state-dir <path> [--id <id>] [--tags <comma-separated>] [--timeout-ms <n>] [--cwd <path>]
  route-classify --config <agent.json> --input <path> --state-dir <path> --max-launches 1 [--id <id>] [--tags <comma-separated>] [--timeout-ms <n>] [--cwd <path>]
  route-inspect --state-dir <path> --id <id>
  evaluate --state-dir <path> [--profile baseline|candidate] [--repetitions <n>] [--case-id <id>] [--model <provider/id> --max-launches <n>]
  evaluation-compare --baseline <report.json> --candidate <report.json>
  trace-inspect --state-dir <path> --episode <id>
  handoff-produce --input <path> --state-dir <path> --id <id> [--target <id>]
  handoff-consume --state-dir <path> --id <id> --authority-file <path> [--target <id>]
  handoff-status --state-dir <path> --id <id>
  tool-demo [--mode mock|codex|claude] [--model <provider/id>]
  triage-decision --input <path> --state-dir <path> --authority-file <path> [--cwd <path>]
  triage --input <path> --state-dir <path> [--model <provider/id>] [--cwd <path>] [--stop-after-intake]
  classify-one --input <path> --model <provider/id> [--cwd <path>] [--ref-out <path>]
  resume-session --ref <path> --model <provider/id> --cwd <path> [--ref-out <path>]
  session-send --prompt-file <path> --model <provider/id> --cwd <path> --ref-out <path> [--ref <path>]
Model commands consume provider capacity. Omit --model from triage for local rules.`;

function parseArguments(args: string[]): { command: string; values: Map<string, string> } {
  const requested = args.shift() ?? 'help';
  const command = requested === 'learn-matrix' ? 'learn-cycle' : requested;
  const flags: Record<string, string[]> = {
    doctor: [],
    'log-run': ['--input','--state-dir','--run-id'],
    'log-inspect': ['--state-dir','--run-id'],
    'log-rebuild': ['--state-dir','--run-id'],
    'log-handoff': ['--state-dir','--run-id'],
    'log-reconcile': ['--state-dir','--run-id'],
    'study-cycle': ['--corpus','--config','--state-dir','--max-launches','--cycles','--batch-id','--operation','--objective','--timeout-ms','--cwd','--total-launches'],
    'study-run': ['--corpus','--config','--state-dir','--input','--max-launches','--auto-improve','--cycles','--objective','--timeout-ms','--cwd','--total-launches'],
    'study-status': ['--corpus','--config','--state-dir','--objective','--timeout-ms','--cwd'],
    'learn-cycle': ['--config','--state-dir','--max-launches','--suite','--operation','--objective','--total-launches','--timeout-ms','--cwd'],
    'learn-run': ['--config','--state-dir','--input','--max-launches','--auto-improve','--suite','--objective','--total-launches','--timeout-ms','--cwd'],
    'learn-status': ['--config','--state-dir','--objective','--timeout-ms','--suite'],
    'route-select': ['--config', '--state-dir', '--id', '--tags', '--timeout-ms', '--cwd'],
    'route-classify': ['--config', '--state-dir', '--input', '--max-launches', '--id', '--tags', '--timeout-ms', '--cwd'],
    'route-inspect': ['--state-dir', '--id'],
    evaluate: ['--state-dir', '--profile', '--repetitions', '--case-id', '--model', '--max-launches', '--timeout-ms', '--cwd'],
    'evaluation-compare': ['--baseline', '--candidate'],
    'trace-inspect': ['--state-dir', '--episode'],
    'handoff-produce': ['--input', '--state-dir', '--id', '--target'],
    'handoff-consume': ['--state-dir', '--id', '--authority-file', '--target'],
    'handoff-status': ['--state-dir', '--id'],
    'tool-demo': ['--mode', '--model'],
    'triage-decision': ['--input', '--state-dir', '--authority-file', '--cwd'],
    triage: ['--input', '--state-dir', '--model', '--cwd', '--stop-after-intake'],
    'classify-one': ['--input', '--model', '--cwd', '--ref-out'],
    'resume-session': ['--ref', '--model', '--cwd', '--ref-out'],
    'session-send': ['--prompt-file', '--model', '--cwd', '--ref-out', '--ref'],
  };
  if (command === 'help' || command === '--help') return { command: 'help', values: new Map() };
  if (!flags[command]) throw new TypeError(`Unknown command ${command}`);
  const values = new Map<string, string>();
  while (args.length > 0) {
    const flag = args.shift()!;
    if (!flags[command]!.includes(flag) || values.has(flag)) throw new TypeError(`Unknown or duplicate argument ${flag}`);
    if (flag === '--stop-after-intake' || flag === '--auto-improve') { values.set(flag, 'true'); continue; }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  return { command, values };
}

function providerExecutable(provider: 'CLAUDE' | 'CODEX' | 'GEMINI' | 'ANTIGRAVITY'): LaunchTarget | undefined {
  const commandVariable = `OAR_${provider}_COMMAND`;
  const argsVariable = `OAR_${provider}_ARGS_JSON`;
  const command = process.env[commandVariable];
  const raw = process.env[argsVariable];
  if (command === undefined && raw === undefined) return undefined;
  if (!command || !isAbsolute(command)) throw new TypeError(`${commandVariable} must be an absolute executable path`);
  let argsPrefix: unknown;
  try { argsPrefix = raw === undefined ? [] : JSON.parse(raw); }
  catch { throw new TypeError(`${argsVariable} must be an array of strings`); }
  if (!Array.isArray(argsPrefix) || argsPrefix.some(value => typeof value !== 'string')) {
    throw new TypeError(`${argsVariable} must be an array of strings`);
  }
  return { command, argsPrefix };
}

async function main(): Promise<void> {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === 'help') { console.log(usage); return; }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new TypeError(`Missing required ${name}`);
    return value;
  };
  if (command.startsWith('log-')) { console.log(JSON.stringify(await loggedCommand(command, values), null, 2)); return; }
  if (command === 'route-inspect') {
    console.log(JSON.stringify(await inspectDocumentRouting(required('--state-dir'), required('--id')), null, 2));
    return;
  }
  const learningOptions = async () => {
    const objective = values.get('--objective') ?? 'quality';
    const suite = values.get('--suite') ?? 'mixed';
    if (!['mixed', 'document'].includes(suite)) throw new TypeError('Invalid learning suite');
    if (!['quality','latency','cost'].includes(objective)) throw new TypeError('Invalid learning objective');
    const routeCwd = values.get('--cwd');
    return { definition: JSON.parse(await readFile(resolve(required('--config')), 'utf8')) as unknown,
      stateDirectory: required('--state-dir'), objective: objective as 'quality'|'latency'|'cost',
      suite: suite as 'mixed'|'document',
      timeoutMs: positiveInteger(values.get('--timeout-ms'), 60000, 2147483647),
      ...(routeCwd === undefined ? {} : { cwd: routeCwd }) };
  };
  if (command === 'learn-status') { console.log(JSON.stringify(await inspectLearning(await learningOptions()), null, 2)); return; }
  const studyOptions = async () => {
    const objective = values.get('--objective') ?? 'quality', studyCwd = values.get('--cwd');
    if (!['quality','latency','cost'].includes(objective)) throw new TypeError('Invalid study objective');
    return { definition: await readStudyJsonFile(required('--config')), corpus: await readStudyJsonFile(required('--corpus')),
      stateDirectory: required('--state-dir'), objective: objective as 'quality'|'latency'|'cost',
      timeoutMs: positiveInteger(values.get('--timeout-ms'), 60000, 2147483647), ...(studyCwd === undefined ? {} : { cwd: studyCwd }) };
  };
  if (command === 'study-status') { console.log(JSON.stringify(await studyStatus(await studyOptions()), null, 2)); return; }
  const geminiExecutable = providerExecutable('GEMINI');
  const antigravityExecutable = providerExecutable('ANTIGRAVITY');
  const claudeExecutable = providerExecutable('CLAUDE'), codexExecutable = providerExecutable('CODEX');
  const runtime = createAppRuntime({
    ...(claudeExecutable === undefined ? {} : { claudeExecutable }), ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(geminiExecutable === undefined ? {} : { geminiExecutable }),
    ...(antigravityExecutable === undefined ? {} : { antigravityExecutable }),
  });
  if (command === 'doctor') { console.log(JSON.stringify(await doctor({ runtime }), null, 2)); return; }
  // Resume never silently falls back to this process's working directory.
  const needsCwd = command === 'resume-session' || command === 'session-send';
  const cwd = await realpath(resolve(needsCwd ? required('--cwd') : values.get('--cwd') ?? process.cwd()));
  if (command === 'session-send') required('--ref-out');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    let result: unknown;
    if (command === 'study-cycle' || command === 'study-run') {
      const operation = values.get('--operation') ?? 'promote', batchId = values.get('--batch-id'), total = values.get('--total-launches');
      if (operation !== 'promote' && operation !== 'rollback') throw new TypeError('Invalid study operation');
      const options = { ...await studyOptions(), runtime, signal: controller.signal,
        maxLaunches: positiveInteger(required('--max-launches'), 1, 10000), cycles: positiveInteger(values.get('--cycles'), 1, 64),
        ...(total === undefined ? {} : { totalLaunches: positiveInteger(total, 1, 10000) }) };
      result = command === 'study-cycle' ? await studyCycle({ ...options, operation, ...(batchId === undefined ? {} : { batchId }) })
        : await studyRun({ ...options, input: await readStudyJsonFile(required('--input')), autoImprove: values.has('--auto-improve') });
    } else if (command === 'learn-cycle' || command === 'learn-run') {
      const suite = values.get('--suite') ?? 'mixed', operation = values.get('--operation') ?? 'promote';
      if (suite !== 'mixed' && suite !== 'document') throw new TypeError('Invalid learning suite');
      if (operation !== 'promote' && operation !== 'rollback') throw new TypeError('Invalid learning operation');
      const total = values.get('--total-launches');
      const options = { ...await learningOptions(), runtime, signal: controller.signal, suite: suite as 'mixed'|'document',
        maxLaunches: positiveInteger(required('--max-launches'), 1, 10000),
        ...(total === undefined ? {} : { totalLaunches: positiveInteger(total, 1, 10000) }) };
      result = command === 'learn-cycle' ? await runLearningCycle({ ...options, operation })
        : await runLearningInput({ ...options, input: JSON.parse(await readFile(resolve(required('--input')), 'utf8')), autoImprove: values.has('--auto-improve') });
    } else if (command === 'route-select' || command === 'route-classify') {
      const id = values.get('--id'), tags = values.get('--tags'), routeCwd = values.get('--cwd');
      const options = { runtime, definition: JSON.parse(await readFile(resolve(required('--config')), 'utf8')) as unknown,
        stateDirectory: required('--state-dir'), signal: controller.signal,
        timeoutMs: positiveInteger(values.get('--timeout-ms'), 30000, 2147483647),
        ...(routeCwd === undefined ? {} : { cwd: routeCwd }), ...(id === undefined ? {} : { id }),
        ...(tags === undefined ? {} : { tags: tags.split(',') }) };
      result = command === 'route-select' ? await selectDocumentAgent(options)
        : await classifyWithSelectedAgent({ ...options,
          maxLaunches: positiveInteger(required('--max-launches'), 1, 1),
          documents: JSON.parse(await readFile(resolve(required('--input')), 'utf8')) });
    } else if (command === 'evaluate') {
      const profile = values.get('--profile') ?? 'candidate';
      if (profile !== 'baseline' && profile !== 'candidate') throw new TypeError('Invalid evaluation profile');
      const model = values.get('--model'), caseId = values.get('--case-id'), maxLaunches = values.get('--max-launches');
      if (model !== undefined && maxLaunches === undefined) throw new TypeError('Model evaluation requires an explicit --max-launches budget');
      result = await evaluateDocuments({ runtime, cwd, stateDirectory: required('--state-dir'), profile,
        repetitions: positiveInteger(values.get('--repetitions'), 1, 100), timeoutMs: positiveInteger(values.get('--timeout-ms'), 60000, 2147483647), signal: controller.signal,
        ...(model === undefined ? {} : { model }), ...(caseId === undefined ? {} : { caseId }),
        ...(maxLaunches === undefined ? {} : { maxLaunches: positiveInteger(maxLaunches, 1, 10000) }) });
    } else if (command === 'evaluation-compare') {
      result = compareDocumentEvaluations(JSON.parse(await readFile(resolve(required('--baseline')), 'utf8')), JSON.parse(await readFile(resolve(required('--candidate')), 'utf8')));
    } else if (command === 'trace-inspect') {
      result = await inspectDocumentTrace(required('--state-dir'), required('--episode'));
    } else if (command === 'handoff-produce') {
      const target = values.get('--target');
      result = await produceDocumentHandoff({ id: required('--id'), stateDirectory: required('--state-dir'), signal: controller.signal,
        documents: JSON.parse(await readFile(resolve(required('--input')), 'utf8')), ...(target === undefined ? {} : { target }) });
    } else if (command === 'handoff-consume') {
      const target = values.get('--target');
      result = await consumeDocumentHandoff({ id: required('--id'), stateDirectory: required('--state-dir'), authorityFile: required('--authority-file'),
        signal: controller.signal, ...(target === undefined ? {} : { target }) });
    } else if (command === 'handoff-status') {
      result = await documentHandoffStatus({ id: required('--id'), stateDirectory: required('--state-dir') });
    } else if (command === 'tool-demo') {
      const mode = values.get('--mode') ?? 'mock';
      if (mode !== 'mock' && mode !== 'codex' && mode !== 'claude') throw new TypeError('Invalid tool-demo mode');
      const model = values.get('--model');
      result = await runToolDemo({ mode, signal: controller.signal, ...(model === undefined ? {} : { model }) });
    } else if (command === 'session-send') {
      const refPath = values.get('--ref');
      const ref = refPath === undefined ? undefined
        : validateSessionRef(JSON.parse(await readFile(resolve(refPath), 'utf8')));
      result = await sessionSend({ runtime, model: required('--model'), cwd, promptFile: required('--prompt-file'),
        signal: controller.signal, ...(ref === undefined ? {} : { ref }) });
    } else if (command === 'resume-session') {
      const ref = validateSessionRef(JSON.parse(await readFile(resolve(required('--ref')), 'utf8')));
      result = await resumeSession({ runtime, model: required('--model'), cwd, ref, signal: controller.signal });
    } else {
      const documents: unknown = JSON.parse(await readFile(resolve(required('--input')), 'utf8'));
      if (command === 'classify-one') {
        result = await classifyOne({ runtime, model: required('--model'), cwd, documents, signal: controller.signal });
      } else if (command === 'triage-decision') {
        const authorityFile = resolve(required('--authority-file'));
        result = await runDecisionGatedTriage({ runtime, stateDirectory: resolve(required('--state-dir')), cwd,
          documents, signal: controller.signal,
          authority: () => validateTriageAuthority(JSON.parse(readFileSync(authorityFile, 'utf8'))) });
      } else {
        const model = values.get('--model');
        result = await runDocumentTriage({ runtime, stateDirectory: resolve(required('--state-dir')), cwd,
          documents, signal: controller.signal, stopAfterIntake: values.has('--stop-after-intake'),
          ...(model === undefined ? {} : { model }) });
      }
    }
    const refOut = values.get('--ref-out');
    if (refOut !== undefined) {
      const ref = (result as { session: unknown }).session;
      await writeFile(resolve(refOut), JSON.stringify(ref, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
