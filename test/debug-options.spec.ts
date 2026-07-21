import { resolveDebugOptions } from '../src/config/debug-options';
import { parseBoolEnv } from '../src/utils/common';
import { ENABLED_ENV_VAR } from '../src/constants';

describe('parseBoolEnv', () => {
  it('parses truthy tokens (case-insensitive)', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'On', ' true ']) {
      expect(parseBoolEnv(v)).toBe(true);
    }
  });

  it('parses falsy tokens (case-insensitive)', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'Off', ' false ']) {
      expect(parseBoolEnv(v)).toBe(false);
    }
  });

  it('returns undefined for unset, empty, or unrecognized values', () => {
    for (const v of [undefined, '', '   ', 'maybe', '2', 'enabled']) {
      expect(parseBoolEnv(v)).toBeUndefined();
    }
  });
});

describe('resolveDebugOptions — enabled resolution', () => {
  const originalEnabled = process.env[ENABLED_ENV_VAR];
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    restore(ENABLED_ENV_VAR, originalEnabled);
    restore('NODE_ENV', originalNodeEnv);
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it('defaults to on outside production when nothing is set', () => {
    delete process.env[ENABLED_ENV_VAR];
    process.env.NODE_ENV = 'development';
    expect(resolveDebugOptions().enabled).toBe(true);
  });

  it('defaults to off in production when nothing is set', () => {
    delete process.env[ENABLED_ENV_VAR];
    process.env.NODE_ENV = 'production';
    expect(resolveDebugOptions().enabled).toBe(false);
  });

  it('honors the explicit option when the env var is unset', () => {
    delete process.env[ENABLED_ENV_VAR];
    process.env.NODE_ENV = 'production';
    expect(resolveDebugOptions({ enabled: true }).enabled).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(resolveDebugOptions({ enabled: false }).enabled).toBe(false);
  });

  it('lets the env var override the explicit option (env wins)', () => {
    process.env[ENABLED_ENV_VAR] = 'true';
    expect(resolveDebugOptions({ enabled: false }).enabled).toBe(true);
    process.env[ENABLED_ENV_VAR] = 'false';
    expect(resolveDebugOptions({ enabled: true }).enabled).toBe(false);
  });

  it('lets the env var override the NODE_ENV default', () => {
    process.env.NODE_ENV = 'production';
    process.env[ENABLED_ENV_VAR] = 'true';
    expect(resolveDebugOptions().enabled).toBe(true); // on despite production

    process.env.NODE_ENV = 'development';
    process.env[ENABLED_ENV_VAR] = 'false';
    expect(resolveDebugOptions().enabled).toBe(false); // off despite development
  });

  it('ignores an unrecognized env value and falls through', () => {
    process.env[ENABLED_ENV_VAR] = 'notabool';
    process.env.NODE_ENV = 'production';
    expect(resolveDebugOptions({ enabled: true }).enabled).toBe(true); // option applies
    expect(resolveDebugOptions().enabled).toBe(false); // else NODE_ENV default
  });
});
