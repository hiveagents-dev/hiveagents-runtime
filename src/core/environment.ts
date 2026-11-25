import type { EnvironmentPolicy } from '../public/types.js';

const MINIMAL_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'SystemRoot',
  'ComSpec',
] as const;

const BOOTSTRAP_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'ComSpec',
] as const;

function copyKeys(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

export function buildEnvironment(
  policy: EnvironmentPolicy,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = policy.mode === 'inherit' ? { ...base } : {};

  if (policy.mode === 'minimal') copyKeys(result, base, MINIMAL_KEYS);
  if (policy.mode === 'explicit') copyKeys(result, base, BOOTSTRAP_KEYS);
  copyKeys(result, base, policy.passthrough ?? []);

  for (const [key, value] of Object.entries(policy.variables ?? {})) {
    result[key] = value;
  }

  result.NO_COLOR = '1';
  result.FORCE_COLOR = '0';
  return result;
}
