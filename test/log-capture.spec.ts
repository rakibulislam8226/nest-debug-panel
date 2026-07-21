import { LogCaptureService } from '../src/logging/log-capture.service';
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
    logs: [],
    timeline: [],
    custom: {},
  };
}

describe('LogCaptureService', () => {
  const options = resolveDebugOptions({ enabled: true });
  const context = new DebugContextService(options);
  let capture: LogCaptureService;
  const originalLog = console.log;

  beforeEach(() => {
    capture = new LogCaptureService(options, context);
    capture.onModuleInit();
  });

  afterEach(() => {
    capture.onModuleDestroy();
  });

  it('restores the original console on destroy', () => {
    expect(console.log).not.toBe(originalLog); // patched
    capture.onModuleDestroy();
    expect(console.log).toBe(originalLog); // restored
  });

  it('captures console output emitted inside a request context', () => {
    const profile = makeProfile('p1');
    context.run(profile, () => {
      console.log('hello %s', 'world');
      console.error('bad', { code: 500 });
      console.warn('careful');
    });
    expect(profile.logs).toHaveLength(3);
    expect(profile.logs?.[0]).toMatchObject({ level: 'log', message: 'hello world' });
    expect(profile.logs?.[1].level).toBe('error');
    expect(profile.logs?.[1].message).toContain('bad');
    expect(profile.logs?.[2]).toMatchObject({ level: 'warn', message: 'careful' });
  });

  it('ignores console output emitted outside any request', () => {
    const profile = makeProfile('p2');
    console.log('startup noise'); // no active context
    context.run(profile, () => {
      // nothing logged here
    });
    expect(profile.logs ?? []).toHaveLength(0);
  });

  it('does not capture when captureLogs is disabled', () => {
    capture.onModuleDestroy(); // restore so we test the disabled instance in isolation
    const off = resolveDebugOptions({ enabled: true, captureLogs: false });
    const offContext = new DebugContextService(off);
    const offCapture = new LogCaptureService(off, offContext);
    offCapture.onModuleInit();
    expect(console.log).toBe(originalLog); // never patched
    const profile = makeProfile('p3');
    offContext.run(profile, () => console.log('quiet'));
    expect(profile.logs ?? []).toHaveLength(0);
    offCapture.onModuleDestroy();
  });
});
