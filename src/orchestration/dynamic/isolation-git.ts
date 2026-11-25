import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { runProcess } from '../../process/run-process.js';
import { AgentRuntimeError } from '../../public/errors.js';

/** Helpers of `gitWorktreeIsolation`: the git process wrapper, name validation and path checks. */

export type DynamicIsolationErrorCode =
  /** A runId, key, ref, prefix or path that is not allowed. Nothing ran. */
  | 'INVALID_INPUT'
  | 'NOT_A_REPOSITORY'
  /** The worktree root is inside the repository's working tree and not ignored by git. */
  | 'ROOT_INSIDE_REPOSITORY'
  /** The path or branch of a worktree is taken by something this isolation did not create. */
  | 'WORKTREE_CONFLICT'
  /**
   * The worktree's `.git` pointer, its directory or its registration (the admin directory's `gitdir`
   * or `commondir`, or an `index` that exists but is not a regular file) is not what git wrote when it
   * was created (for example a `.git` or `commondir` file an agent rewrote): no git command runs
   * there, and it is kept.
   */
  | 'WORKTREE_UNTRUSTED'
  | 'GIT_UNAVAILABLE'
  | 'GIT_FAILED'
  | 'OUTPUT_LIMIT'
  | 'TIMEOUT'
  | 'ABORTED';

/** The message carries the code, and for git failures the subcommand and exit code: never git's output. */
export class DynamicIsolationError extends Error {
  readonly code: DynamicIsolationErrorCode;
  readonly subcommand?: string;
  readonly exitCode?: number | null;

  constructor(code: DynamicIsolationErrorCode, detail?: { subcommand?: string; exitCode?: number | null; reason?: string }) {
    const git = detail?.subcommand ? `: git ${detail.subcommand}${detail.exitCode === undefined ? '' : ` (exit ${detail.exitCode})`}` : '';
    super(`Worktree isolation refused: ${code}${git}${detail?.reason ? ` (${detail.reason})` : ''}`);
    this.name = 'DynamicIsolationError';
    this.code = code;
    if (detail?.subcommand) this.subcommand = detail.subcommand;
    if (detail?.exitCode !== undefined) this.exitCode = detail.exitCode;
  }
}

const NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * A git ref path built only from `[A-Za-z0-9._/-]`: no `..`, no leading `-` or `/`, no empty or
 * dot-led segment, no `.lock` segment, no trailing `/` or `.`. It is safe as an argv element, a
 * ref name and a relative path.
 */
export function isSafeRefPath(value: unknown, maxLength = 200): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !NAME.test(value)) return false;
  if (value.includes('..') || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every(segment => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export function requireSafe(value: unknown, what: string, maxLength?: number): string {
  if (!isSafeRefPath(value, maxLength)) throw new DynamicIsolationError('INVALID_INPUT', { reason: what });
  return value;
}

/** The directory/branch leaf of one agent call: a slug of its label (cosmetic) plus a digest of its key (identity). */
export function shortKey(key: string, label?: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  const slug = (label ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+/, '').slice(0, 32).replace(/[-.]+$/, '');
  return slug ? `${slug}-${digest}` : digest;
}

const LEAF = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}-)?[0-9a-f]{12}$/;

/** Whether a directory name has the shape `shortKey` gives (which a nested run's directory, such as `sub`, does not). */
export function isLeafName(name: string): boolean {
  return LEAF.test(name) && isSafeRefPath(name);
}

export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** The realpath of the deepest existing ancestor, with the missing tail appended. */
export async function realpathNearest(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await realpathNearest(parent), basename(path));
  }
}

export interface GitOptions {
  cwd: string;
  /** Names the failure without echoing arguments or output. */
  subcommand: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Exit codes that are answers, not failures (e.g. 1 for `check-ignore`). */
  accept?: readonly number[];
  maxOutputBytes?: number;
  /**
   * Variables added to the scrubbed environment: only the SDK's own `GIT_INDEX_FILE` and
   * `GIT_COMMON_DIR`, which name files it verified instead of ones git would look up in a worktree.
   */
  env?: Readonly<Partial<Record<'GIT_INDEX_FILE' | 'GIT_COMMON_DIR', string>>>;
}

let environment: NodeJS.ProcessEnv | undefined;

/** The parent's environment without any `GIT_*` variable that could redirect the repository, index or config. */
function gitEnvironment(): NodeJS.ProcessEnv {
  if (!environment) {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^GIT_/i.test(name)) env[name] = value;
    }
    environment = Object.freeze({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' });
  }
  return environment;
}

/**
 * Configuration every SDK git command (and any git it starts, through `GIT_CONFIG_PARAMETERS`) runs
 * with: no hooks, no fsmonitor, no system or global attributes file, and no `core.ignoreStat`, which
 * would mark checked-out files assume-unchanged and hide later edits from inspection.
 */
const BASE_CONFIG = [
  '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${devNull}`, '-c', 'core.ignoreStat=false',
] as const;

/**
 * Runs git without a shell, in its own process group, under a deadline, with `BASE_CONFIG` and
 * without system attributes: creating or inspecting a worktree never runs code through the
 * repository's hooks or fsmonitor.
 */
export async function git(args: readonly string[], options: GitOptions): Promise<{ code: number; stdout: string }> {
  let outcome;
  try {
    outcome = await runProcess({
      command: 'git',
      args: [...BASE_CONFIG, ...args],
      cwd: options.cwd,
      env: options.env ? { ...gitEnvironment(), ...options.env } : gitEnvironment(),
      stdin: '',
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const subcommand = options.subcommand;
    if (error instanceof AgentRuntimeError) {
      if (error.code === 'TIMEOUT') throw new DynamicIsolationError('TIMEOUT', { subcommand });
      if (error.code === 'ABORTED') throw new DynamicIsolationError('ABORTED', { subcommand });
      if (error.code === 'OUTPUT_LIMIT') throw new DynamicIsolationError('OUTPUT_LIMIT', { subcommand });
      if (error.code === 'PROVIDER_UNAVAILABLE') throw new DynamicIsolationError('GIT_UNAVAILABLE', { subcommand });
    }
    throw new DynamicIsolationError('GIT_FAILED', { subcommand });
  }
  const code = outcome.code ?? -1;
  if (code !== 0 && !(options.accept ?? []).includes(code)) {
    throw new DynamicIsolationError('GIT_FAILED', { subcommand: options.subcommand, exitCode: outcome.code });
  }
  return { code, stdout: outcome.stdout };
}

export interface WorktreeEntry {
  readonly path: string;
  /** `refs/heads/...`, absent when detached or bare. */
  readonly branch?: string;
  /** The commit HEAD names, when git could resolve it. */
  readonly head?: string;
  readonly prunable: boolean;
}

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path: string; branch?: string; head?: string; prunable: boolean } | undefined;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: field.slice('worktree '.length), prunable: false };
    } else if (current && field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length);
    } else if (current && field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length);
    } else if (current && (field === 'prunable' || field.startsWith('prunable '))) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}
