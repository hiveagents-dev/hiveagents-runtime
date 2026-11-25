import { describe, expect, it } from 'vitest';

import {
  Agent,
  AgentRuntimeError,
  SessionBusyError,
  doctor,
  resolveModel,
} from '../../src/index.js';

describe('public package surface', () => {
  it('exports the phase 1 entry points', () => {
    expect(Agent).toBeTypeOf('function');
    expect(AgentRuntimeError).toBeTypeOf('function');
    expect(SessionBusyError).toBeTypeOf('function');
    expect(doctor).toBeTypeOf('function');
    expect(resolveModel).toBeTypeOf('function');
  });

  // The platform repository consumes this package from a tarball, so what its tests need has to be
  // public: the Claude result parser, and the recipe matcher a hosted worker runs before a turn leaves it.
  it('exports what an external host needs to check its own turns', async () => {
    const root = await import('../../src/index.js'), hosted = await import('../../src/hosted-runtime.js');
    expect(root.parseClaudeJsonl).toBeTypeOf('function');
    expect(root.buildEnvironment).toBeTypeOf('function');
    expect(root.translateContext).toBeTypeOf('function');
    expect(hosted.createRecipeMatcher).toBeTypeOf('function');
    const failure = root.parseClaudeJsonl(JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true }));
    expect(failure).toBeTypeOf('object');
  });
});
