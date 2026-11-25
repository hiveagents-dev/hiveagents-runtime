import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

export interface LaunchTarget {
  command: string;
  argsPrefix: string[];
}

export function resolveBinary(
  name: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): LaunchTarget | undefined {
  return resolveBinaryCandidates(name, options)[0];
}

/** Ordered, canonical, unique executables. A stale shim must not hide a healthy install later on PATH. */
export function resolveBinaryCandidates(
  name: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): LaunchTarget[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32') {
    const candidates = name.includes('/')
      ? [name]
      : (env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, name));
    const targets = new Map<string, LaunchTarget>();
    for (const candidate of candidates) {
      try {
        accessSync(candidate, constants.X_OK);
        const command = realpathSync(candidate);
        targets.set(command, { command, argsPrefix: [] });
      } catch {
        // Continue through PATH; unreadable, missing, and non-executable entries are unusable.
      }
    }
    return [...targets.values()];
  }

  let paths: string[];
  try {
    const output = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    paths = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }

  const executables = paths.filter(
    (path) => extname(path).toLowerCase() === '.exe' && existsSync(path),
  );
  return [...new Set(executables.map(path => realpathSync(path)))].map(command => ({ command, argsPrefix: [] }));
}
