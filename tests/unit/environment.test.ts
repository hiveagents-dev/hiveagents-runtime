import { describe, expect, it } from 'vitest';

import { buildEnvironment } from '../../src/index.js';

const base = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  LANG: 'en_US.UTF-8',
  AWS_SECRET_ACCESS_KEY: 'secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
};

describe('environment policy', () => {
  it('honestly inherits credentials in inherit mode', () => {
    expect(buildEnvironment({ mode: 'inherit' }, base).AWS_SECRET_ACCESS_KEY).toBe('secret');
  });

  it('uses an explicit allowlist in minimal mode without regex claims', () => {
    const env = buildEnvironment({ mode: 'minimal' }, base);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('passes requested authentication variables consistently', () => {
    const env = buildEnvironment({
      mode: 'minimal',
      passthrough: ['CLAUDE_CODE_OAUTH_TOKEN'],
      variables: { CUSTOM_FLAG: '1' },
    }, base);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(env.CUSTOM_FLAG).toBe('1');
  });

  it('keeps only bootstrap and declared values in explicit mode', () => {
    const env = buildEnvironment({ mode: 'explicit', variables: { ONLY: 'yes' } }, base);

    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/dev', ONLY: 'yes' });
    expect(env.LANG).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('preserves macOS keychain bootstrap paths without leaking token variables', () => {
    const env = buildEnvironment({ mode: 'minimal' }, {
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      TMPDIR: '/var/folders/task/T/',
      SHELL: '/bin/zsh',
      CLAUDE_CODE_OAUTH_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
    });

    expect(env).toMatchObject({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      TMPDIR: '/var/folders/task/T/',
      SHELL: '/bin/zsh',
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
