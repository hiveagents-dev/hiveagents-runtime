import type { ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import type { CliCompatibilityAssessment } from '../../src/compatibility/manifest.js';
import type { ProviderId } from '../../src/public/types.js';

/** Shared by the Claude and Codex control factory suites: exec must never be used by a control session. */
export class FakeExecAdapter implements ExecAdapter {
  assessment: CliCompatibilityAssessment | undefined;
  constructor(readonly id: ProviderId) {}

  async detect() {
    return { installed: true, path: `/bin/${this.id}`, realpath: `/bin/${this.id}`, version: '1.0.0' };
  }

  async auth() {
    return { authenticated: true, source: 'subscription' as const };
  }

  async models() {
    return [];
  }

  async compatibility() { return this.assessment!; }

  async execute(_request: ExecTurnRequest): Promise<ProtocolResult> {
    throw new Error('the control transport must never fall back to exec');
  }
}
