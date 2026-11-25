import { rethrowExecutionHalt } from '../public/execution-halt.js';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { ExecProbeContext, ProcessRunner } from '../adapters/provider.js';
import type { ProviderInstallation } from '../public/types.js';
import { resolveBinary, resolveBinaryCandidates, type LaunchTarget } from './resolve-binary.js';

/** Fall back only after an executable fails its version probe. Never switch accounts
 * after an auth failure, override an explicit target, or expand the caller's PATH. */
export class ExecDiscovery {
  readonly #selected = new WeakMap<NodeJS.ProcessEnv, LaunchTarget>();
  constructor(readonly name: string, readonly runner: ProcessRunner, readonly configured?: LaunchTarget) {}

  target(env: NodeJS.ProcessEnv): LaunchTarget | undefined {
    return this.configured ?? this.#selected.get(env) ?? resolveBinary(this.name, { env });
  }

  async detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext): Promise<ProviderInstallation> {
    this.#selected.delete(env);
    const candidates = this.configured ? [this.configured] : resolveBinaryCandidates(this.name, { env });
    for (const target of candidates) {
      if (context?.signal.aborted) throw context.signal.reason;
      try {
        const result = await this.runner({ command: target.command, args: [...target.argsPrefix, '--version'],
          cwd: process.cwd(), env, stdin: '', timeoutMs: Math.min(15_000, context?.remainingMs() ?? 15_000), maxOutputBytes: 16_384, ...(context ? { signal: context.signal } : {}) });
        if (result.code !== 0) continue;
        // Keep a prerelease suffix: `0.153.5-alpha.1` is not `0.153.5`, and the manifest ranges must not match it.
        const version = result.stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
        // Scope selection to this readiness probe, not other concurrent agents sharing PATH.
        // Agent pins the detected target for subsequent sessions.
        this.#selected.set(env, target);
        const command = await realpath(target.command).catch(() => target.command);
        const identityFiles = await Promise.all(target.argsPrefix.filter((arg) => isAbsolute(arg)).map((file) => realpath(file)));
        const launchTarget = { command, argsPrefix: [...target.argsPrefix] };
        return { installed: true, path: command, launchTarget, ...(identityFiles.length ? { identityFiles } : {}), ...(version ? { version } : {}) };
      } catch (error) {
        rethrowExecutionHalt(error);
        if (context?.signal.aborted) throw context.signal.reason ?? error;
        /* An unavailable shim can fail before producing an exit code. */
      }
    }
    return { installed: false };
  }
}
