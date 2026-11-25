import { isAbsolute, relative, resolve, sep } from 'node:path';

import { UnsupportedCapabilityError } from '../public/errors.js';
import type { PermissionModeCeiling } from '../public/types.js';

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);
  return pathFromRoot === ''
    || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

export function assertPathWithinRoots(candidate: string, roots: readonly string[]): void {
  if (roots.some((root) => isPathWithinRoot(candidate, root))) return;
  throw new UnsupportedCapabilityError(
    { retryable: false },
    'Path is outside the immutable SafetyEnvelope',
  );
}

export const PERMISSION_MODE_AUTHORITY: Readonly<Record<PermissionModeCeiling, number>> =
  Object.freeze({ plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 });

export function isPermissionModeWithinCeiling(
  mode: string,
  ceiling: PermissionModeCeiling | undefined,
): boolean {
  if (ceiling === undefined) return true;
  const modeRank = PERMISSION_MODE_AUTHORITY[mode as PermissionModeCeiling];
  const ceilingRank = PERMISSION_MODE_AUTHORITY[ceiling];
  // An unrecognized mode fails closed: its authority cannot be compared.
  if (modeRank === undefined || ceilingRank === undefined) return false;
  return modeRank <= ceilingRank;
}

export function assertPermissionModeWithinCeiling(
  mode: string,
  ceiling: PermissionModeCeiling | undefined,
): void {
  if (isPermissionModeWithinCeiling(mode, ceiling)) return;
  throw new UnsupportedCapabilityError(
    { retryable: false },
    `Permission mode "${mode}" exceeds the SafetyEnvelope ceiling "${ceiling}"`,
  );
}

export function isModelAllowed(
  model: string,
  allowlist: readonly string[] | undefined,
): boolean {
  return allowlist === undefined || allowlist.includes(model);
}

export function assertModelAllowed(
  model: string,
  allowlist: readonly string[] | undefined,
): void {
  if (isModelAllowed(model, allowlist)) return;
  throw new UnsupportedCapabilityError(
    { retryable: false },
    `Model "${model}" is outside the SafetyEnvelope model allowlist`,
  );
}
