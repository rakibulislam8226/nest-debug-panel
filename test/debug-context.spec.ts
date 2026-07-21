import { DebugContextService } from '../src/context/debug-context.service';
import { resolveDebugOptions } from '../src/config/debug-options';
import type { RequestProfile } from '../src/interfaces/profile.interface';

function makeProfile(id: string): RequestProfile {
  return {
    id,
    method: 'GET',
    url: '/x',
    queryParams: {},
    routeParams: {},
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    sql: [],
    redis: [],
    http: [],
    timeline: [],
    custom: {},
  };
}

describe('DebugContextService', () => {
  const service = new DebugContextService(resolveDebugOptions({ enabled: true }));

  it('is inactive outside a request context and record calls no-op', () => {
    expect(service.isActive()).toBe(false);
    expect(() =>
      service.recordSql({ source: 'test', sql: 'SELECT 1', durationMs: 1 }),
    ).not.toThrow();
  });

  it('records events into the active profile', () => {
    const profile = makeProfile('p1');
    service.run(profile, () => {
      service.recordSql({ source: 'test', sql: 'SELECT 1', durationMs: 2 });
      service.recordRedis({ command: 'GET', args: ['key'], durationMs: 1 });
      service.recordHttp({ source: 'fetch', method: 'get', url: 'http://x', durationMs: 3, statusCode: 200 });
      service.mark('checkpoint', 1.5);
      service.setCustom('answer', 42);
    });
    expect(profile.sql).toHaveLength(1);
    expect(profile.redis).toHaveLength(1);
    expect(profile.http[0].method).toBe('GET');
    expect(profile.custom['answer']).toBe(42);
    // request-start entries are pushed by the interceptor; here: sql + redis + http + mark
    expect(profile.timeline).toHaveLength(4);
    expect(profile.timeline.every((event) => event.at >= 0)).toBe(true);
  });

  it('isolates concurrent contexts', async () => {
    const a = makeProfile('a');
    const b = makeProfile('b');
    await Promise.all([
      service.run(a, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        service.recordSql({ source: 'test', sql: 'SELECT a', durationMs: 1 });
        expect(service.getProfile()?.id).toBe('a');
      }),
      service.run(b, async () => {
        service.recordSql({ source: 'test', sql: 'SELECT b', durationMs: 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(service.getProfile()?.id).toBe('b');
      }),
    ]);
    expect(a.sql.map((q) => q.sql)).toEqual(['SELECT a']);
    expect(b.sql.map((q) => q.sql)).toEqual(['SELECT b']);
  });

  it('respects capture flags', () => {
    const gated = new DebugContextService(
      resolveDebugOptions({ enabled: true, captureSql: false, captureRedis: false, captureHttp: false }),
    );
    const profile = makeProfile('gated');
    gated.run(profile, () => {
      gated.recordSql({ source: 'test', sql: 'SELECT 1', durationMs: 1 });
      gated.recordRedis({ command: 'GET', durationMs: 1 });
      gated.recordHttp({ source: 'axios', method: 'GET', url: 'http://x', durationMs: 1 });
    });
    expect(profile.sql).toHaveLength(0);
    expect(profile.redis).toHaveLength(0);
    expect(profile.http).toHaveLength(0);
  });

  it('records logs into the active profile', () => {
    const profile = makeProfile('logs');
    service.run(profile, () => {
      service.recordLog({ level: 'info', message: 'hello world' });
      service.recordLog({ level: 'error', message: 'boom', context: 'AuthService' });
    });
    expect(profile.logs).toHaveLength(2);
    expect(profile.logs?.[0]).toMatchObject({ level: 'info', message: 'hello world' });
    expect(profile.logs?.[1]).toMatchObject({ level: 'error', context: 'AuthService' });
    expect(profile.logs?.every((log) => log.at >= 0)).toBe(true);
  });

  it('respects the captureLogs flag', () => {
    const gated = new DebugContextService(resolveDebugOptions({ enabled: true, captureLogs: false }));
    const profile = makeProfile('nolog');
    gated.run(profile, () => gated.recordLog({ level: 'log', message: 'ignored' }));
    expect(profile.logs ?? []).toHaveLength(0);
  });

  it('records exceptions with stack and status', () => {
    const profile = makeProfile('err');
    service.run(profile, () => {
      service.recordException(Object.assign(new Error('boom'), { getStatus: () => 400 }));
    });
    expect(profile.exception?.message).toBe('boom');
    expect(profile.exception?.statusCode).toBe(400);
    expect(profile.exception?.stack).toBeDefined();
  });
});
