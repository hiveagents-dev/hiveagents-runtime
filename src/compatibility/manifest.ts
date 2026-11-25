import { UnknownProviderError } from '../public/errors.js';
import type { BuiltinProviderId, CapabilitySupport, ProviderId, TransportKind } from '../public/types.js';
import {
  parseCliVersion,
  parseCliVersionRange,
  rangeIncludes,
  rangesConflict,
  type CliVersionRange,
} from './version-range.js';

export interface CompatibilityEntry {
  provider: ProviderId;
  /** An exact `MAJOR.MINOR.PATCH` or a half-open `>=LOW <HIGH`; see `version-range.ts`. */
  cliRange: string;
  transport: TransportKind;
  evidence: 'live-contract' | 'help-probe' | 'unverified';
  features: Record<string, CapabilitySupport>;
  knownIssues: string[];
}

export interface CliHelpProbe {
  main: string;
  resume?: string;
  fork?: string;
}

export interface CliCompatibilityAssessment {
  responsePolicy?: { supported: boolean; missing: string[] };
  provider: ProviderId;
  cliVersion: string;
  transport: TransportKind;
  evidence: CompatibilityEntry['evidence'];
  features: Record<string, CapabilitySupport>;
  missingFlags: string[];
  knownIssues: string[];
}

type FlagRequirement = { surface: keyof CliHelpProbe; flags: string[] };

const REQUIRED_FLAGS: Record<BuiltinProviderId, Record<string, FlagRequirement>> = {
  claude: {
    turns: { surface: 'main', flags: ['--print', '--output-format', '--model', '--session-id', '--verbose'] },
    resume: { surface: 'main', flags: ['--resume'] },
    forkWithPrompt: { surface: 'main', flags: ['--fork-session'] },
    structuredOutput: { surface: 'main', flags: ['--json-schema'] },
    tokenDeltas: { surface: 'main', flags: ['--include-partial-messages'] },
    cleanContext: { surface: 'main', flags: ['--safe-mode'] },
    permissions: { surface: 'main', flags: ['--permission-mode'] },
  },
  codex: {
    turns: { surface: 'main', flags: ['--json', '--model'] },
    resume: { surface: 'resume', flags: ['--json', '--model'] },
    forkWithPrompt: { surface: 'fork', flags: ['--json', '--model'] },
    structuredOutput: { surface: 'main', flags: ['--output-schema'] },
    cleanContext: { surface: 'main', flags: ['--ignore-user-config', '--ignore-rules'] },
    permissions: { surface: 'main', flags: ['--sandbox'] },
  },
};

/**
 * Flags an option line defines: the line must begin (after indentation) with a dash, and only its
 * definition column counts, i.e. the text before the first run of two spaces or a tab. A flag merely
 * mentioned in a description or a usage paragraph is not evidence that the CLI accepts it.
 */
function definedFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    if (!/^\s*-/.test(line)) continue;
    const definition = line.trimStart().split(/ {2,}|\t/)[0] ?? '';
    for (const match of definition.matchAll(/(?:^|[\s,[])(--[\w-]+)/g)) flags.add(match[1]!);
  }
  return flags;
}

function hasFlag(help: string | undefined, flag: string): boolean {
  return help ? definedFlags(help).has(flag) : false;
}

export function assessCliCompatibility(
  provider: ProviderId,
  cliVersion: string,
  help: CliHelpProbe,
): CliCompatibilityAssessment {
  if (provider !== 'claude' && provider !== 'codex') throw new UnknownProviderError(provider);
  const manifest = findCompatibilityEntry(provider, 'exec', cliVersion);
  const features: Record<string, CapabilitySupport> = manifest
    ? { ...manifest.features }
    : {};
  const missingFlags: string[] = [];

  for (const [feature, requirement] of Object.entries(REQUIRED_FLAGS[provider as BuiltinProviderId])) {
    const missing = requirement.flags.filter((flag) => !hasFlag(help[requirement.surface], flag));
    if (missing.length > 0) {
      features[feature] = 'unsupported';
      missingFlags.push(...missing);
    } else if (!manifest || manifest.evidence !== 'live-contract') {
      // Only a live contract turns a visible flag into 'supported'; a help probe never does.
      if (features[feature] === undefined || features[feature] === 'supported') features[feature] = 'unverified';
    } else if (features[feature] === undefined) {
      features[feature] = 'supported';
    }
  }
  if (provider === 'codex') features.tokenDeltas = 'unsupported';
  const responseMissing = provider === 'claude' ? ['--system-prompt', '--safe-mode', '--tools', '--allowed-tools', '--strict-mcp-config', '--permission-mode']
    .filter(flag => !hasFlag(help.main, flag)) : [];
  if (provider === 'claude' && !/\bdontAsk\b/.test(help.main)) responseMissing.push('permission-mode.dontAsk');

  return {
    ...(provider === 'claude' ? { responsePolicy: { supported: responseMissing.length === 0, missing: responseMissing } } : {}),
    provider,
    cliVersion,
    transport: 'exec',
    evidence: manifest && missingFlags.length === 0 ? manifest.evidence : 'help-probe',
    features,
    missingFlags: [...new Set(missingFlags)],
    knownIssues: manifest?.knownIssues ?? ['CLI version is outside the exact tested manifest'],
  };
}

/**
 * The entry for an installed version: an exact entry wins over an interval that contains it; nothing else may
 * overlap (see `validateCompatibilityManifest`). A malformed or prerelease version matches nothing.
 */
export function findCompatibilityEntry(
  provider: ProviderId,
  transport: TransportKind,
  cliVersion: string,
  manifest: readonly CompatibilityEntry[] = COMPATIBILITY_MANIFEST,
): CompatibilityEntry | undefined {
  const version = parseCliVersion(cliVersion);
  if (!version) return undefined;
  const matches = manifest
    .filter((entry) => entry.provider === provider && entry.transport === transport)
    .map((entry) => ({ entry, range: parseCliVersionRange(entry.cliRange) }))
    .filter(({ range }) => rangeIncludes(range, version));
  const exact = matches.filter(({ range }) => range.kind === 'exact');
  const best = exact.length > 0 ? exact : matches;
  if (best.length > 1) {
    throw new Error(`Compatibility manifest is ambiguous for ${provider} ${transport} ${cliVersion}: ${best.map(({ range }) => range.source).join(', ')}`);
  }
  return best[0]?.entry;
}

/**
 * Programming-error checks for a manifest: every range parses, no two entries for the same provider and transport
 * overlap (an exact version inside an interval is allowed and wins), and an entry whose evidence is not a live
 * contract never declares a feature 'supported'. Throws the first violation.
 */
export function validateCompatibilityManifest(manifest: readonly CompatibilityEntry[]): void {
  const parsed: { entry: CompatibilityEntry; range: CliVersionRange }[] = [];
  for (const entry of manifest) {
    const range = parseCliVersionRange(entry.cliRange);
    for (const other of parsed) {
      if (other.entry.provider === entry.provider && other.entry.transport === entry.transport
        && rangesConflict(other.range, range)) {
        throw new Error(`Compatibility ranges overlap for ${entry.provider} ${entry.transport}: ${other.range.source} and ${range.source}`);
      }
    }
    if (entry.evidence !== 'live-contract') {
      const claimed = Object.entries(entry.features).filter(([, support]) => support === 'supported').map(([name]) => name);
      if (claimed.length > 0) {
        throw new Error(`${entry.provider} ${entry.cliRange} has ${entry.evidence} evidence but declares supported: ${claimed.join(', ')}`);
      }
    }
    parsed.push({ entry, range });
  }
}

export const COMPATIBILITY_MANIFEST: readonly CompatibilityEntry[] = [
  {
    provider: 'claude',
    cliRange: '2.1.251',
    transport: 'exec',
    evidence: 'live-contract',
    features: {
      resume: 'supported',
      forkWithPrompt: 'supported',
      forkWithoutPrompt: 'unsupported',
      structuredOutput: 'supported',
      tokenDeltas: 'supported',
      cleanContext: 'supported',
    },
    knownIssues: [
      'Exit code 0 can contain an is_error result envelope',
      'Promptless fork is not a verified exec semantic',
    ],
  },
  {
    provider: 'claude',
    cliRange: '2.1.228',
    transport: 'exec',
    evidence: 'live-contract',
    features: {
      resume: 'supported',
      forkWithPrompt: 'supported',
      forkWithoutPrompt: 'unsupported',
      structuredOutput: 'supported',
      tokenDeltas: 'supported',
      cleanContext: 'supported',
    },
    knownIssues: ['Promptless fork is not supported by print mode even though --fork-session exists'],
  },
  {
    provider: 'codex',
    cliRange: '0.149.0',
    transport: 'exec',
    evidence: 'live-contract',
    features: {
      resume: 'supported',
      forkWithPrompt: 'supported',
      forkWithoutPrompt: 'unsupported',
      structuredOutput: 'supported',
      tokenDeltas: 'unsupported',
      cleanContext: 'partial',
    },
    knownIssues: [
      'Exit code 0 can contain error events without turn.completed',
      'Error items may also be recoverable when followed by turn.completed',
      'Promptless exec fork rejects empty stdin',
    ],
  },
  {
    // Evidence: `codex --version` = codex-cli 0.153.4 and `codex --help`, `codex exec --help`, `codex exec resume
    // --help`, `codex exec fork --help` on 2026-11-14. Every flag the exec adapter emits is defined on the surface
    // where the adapter places it. No turn ran for this entry, so nothing here is 'supported': visible flags stay
    // 'unverified', and only known limits are stated. 0.153.0-0.153.3 were never observed and stay outside.
    provider: 'codex',
    cliRange: '>=0.153.4 <0.154.0',
    transport: 'exec',
    evidence: 'help-probe',
    features: {
      forkWithoutPrompt: 'unsupported',
      tokenDeltas: 'unsupported',
      cleanContext: 'partial',
    },
    knownIssues: [
      'Help-probed only: no live contract turn backs this range',
      '--ask-for-approval is defined by top-level codex --help, not by codex exec --help, which is the only main surface probed',
    ],
  },
] as const;
