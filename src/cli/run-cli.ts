import { compatibilityModels } from '../core/models.js';
import { defaultRuntime, type Runtime } from '../core/runtime.js';
import { Agent } from '../public/agent.js';
import { AgentRuntimeError } from '../public/errors.js';
import { doctor } from '../public/doctor.js';
import { shareDoctorReport } from './share-doctor.js';

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const processIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

/** Options that take a value, per command. */
const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  concurrency: ['--database', '--expected-revision'],
  doctor: [],
  models: [],
  capabilities: ['--model'],
  run: ['--model'],
};

const FLAG_OPTIONS: Readonly<Partial<Record<string, readonly string[]>>> = { doctor: ['--share'] };

class UsageError extends Error {}

interface ParsedArgs {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

/**
 * Parses the arguments after the command. A value option takes the next argument or `--name=value`;
 * a value that starts with `--` is refused instead of swallowed. Flags take no value.
 * `--` ends option parsing.
 */
function parseArgs(args: readonly string[], valueOptions: readonly string[], flagOptions: readonly string[]): ParsedArgs {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals > 0 && arg.startsWith('--') ? arg.slice(0, equals) : arg;
    if (flagOptions.includes(name)) {
      if (flags.has(name)) throw new UsageError(`${name} given more than once`);
      if (name !== arg) throw new UsageError(`${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!valueOptions.includes(name)) throw new UsageError(`Unknown option ${name}`);
    if (options.has(name)) throw new UsageError(`${name} given more than once`);
    const value = name === arg ? args[index += 1] : arg.slice(equals + 1);
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new UsageError(`${name} requires a value`);
    }
    options.set(name, value);
  }
  return { options, flags, positionals };
}

export async function runCli(
  args: string[],
  io: CliIo = processIo,
  runtime: Runtime = defaultRuntime,
): Promise<number> {
  const command = args[0] ?? 'doctor';
  let parsed: ParsedArgs = { options: new Map(), flags: new Set(), positionals: [] };
  const valueOptions = VALUE_OPTIONS[command];
  if (valueOptions && Object.hasOwn(VALUE_OPTIONS, command)) {
    try {
      parsed = parseArgs(args.slice(1), valueOptions, FLAG_OPTIONS[command] ?? []);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      io.stderr(`${error.message}\n`);
      return 2;
    }
  }
  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      io.stdout([
        'Usage: hiveagents-runtime <command>',
        '',
        'Commands:',
        '  concurrency <provider> [N|unlimited] [--database PATH] [--expected-revision N]',
        '  doctor [--share]                Diagnose providers; --share omits local metadata',
        '  models                          List the compatibility model catalog',
        '  capabilities --model <id>       Show the capability report for a model',
        '  run --model <id> [--] <prompt...> Run a one-shot turn and print the response',
        '  help                            Show this message',
        '',
      ].join('\n'));
      return 0;
    }
    if (command === 'concurrency') {
      const [provider, value] = parsed.positionals;
      const revision = parsed.options.get('--expected-revision');
      const validNumber = (s: string) => /^(0|[1-9]\d*)$/.test(s) && Number.isSafeInteger(Number(s));
      if (!provider || parsed.positionals.length > 2 || (value !== undefined && value !== 'unlimited' && !validNumber(value))
        || (revision !== undefined && (value === undefined || !validNumber(revision)))) {
        io.stderr('Usage: hiveagents-runtime concurrency <provider> [N|unlimited] [--database PATH] [--expected-revision N]\n');
        return 2;
      }
      const { HostLedger } = await import('../orchestration/budget/host-ledger.js');
      const path = parsed.options.get('--database');
      const ledger = new HostLedger(path ? {databasePath:path} : {});
      try {
        const current = ledger.getConcurrency(provider);
        const result = value === undefined || !current.ok ? current : ledger.setConcurrency(provider, {
          expectedRevision: revision === undefined ? current.policy.revision : Number(revision),
          concurrency: value === 'unlimited' ? {mode:'unlimited'} : {mode:'limited',maxConcurrent:Number(value)},
        });
        io.stdout(JSON.stringify(result)+'\n');
        return result.ok ? 0 : 1;
      } finally { ledger.close(); }
    }
    if (command === 'doctor') {
      const report = await doctor({ runtime });
      const output = parsed.flags.has('--share') ? shareDoctorReport(report) : report;
      io.stdout(`${JSON.stringify(output, null, 2)}\n`);
      return 0;
    }
    if (command === 'models') {
      io.stdout(`${JSON.stringify(await runtime.models(), null, 2)}\n`);
      return 0;
    }
    if (command === 'capabilities') {
      const model = parsed.options.get('--model');
      if (!model) {
        io.stderr('capabilities requires --model <id>\n');
        return 2;
      }
      const report = await new Agent({ model }, runtime).capabilities();
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    if (command === 'run') {
      const model = parsed.options.get('--model');
      if (!model) {
        io.stderr('run requires --model <id>\n');
        return 2;
      }
      const prompt = parsed.positionals.join(' ').trim();
      if (!prompt) {
        io.stderr('run requires a prompt\n');
        return 2;
      }
      const turn = await new Agent({ model }, runtime).run(prompt);
      io.stdout(`${turn.text}\n`);
      return 0;
    }
    io.stderr(`Unknown command: ${command}\n`);
    return 2;
  } catch (error) {
    if (command === 'doctor' && parsed.flags.has('--share')) {
      io.stderr('Unable to generate the shareable diagnostic report.\n');
      return 1;
    }
    if (error instanceof AgentRuntimeError) {
      io.stderr(`${error.code}: ${error.message}\n`);
      return 1;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
