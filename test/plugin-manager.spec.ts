import { PluginManager } from '../src/plugins/plugin-manager.service';
import { DebugContextService } from '../src/context/debug-context.service';
import { resolveDebugOptions } from '../src/config/debug-options';
import { MemoryStorage } from '../src/storage/memory.storage';
import type { DebugPlugin } from '../src/interfaces/plugin.interface';
import type { RequestProfile } from '../src/interfaces/profile.interface';

function makeProfile(): RequestProfile {
  return {
    id: 'p',
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

function makeManager(plugins: DebugPlugin[], captureMemory = false): PluginManager {
  const options = resolveDebugOptions({ enabled: true, captureMemory, plugins });
  return new PluginManager(options, new MemoryStorage(10), new DebugContextService(options));
}

describe('PluginManager', () => {
  it('registers plugins and dispatches lifecycle hooks', async () => {
    const calls: string[] = [];
    const plugin: DebugPlugin = {
      name: 'spy',
      register: () => void calls.push('register'),
      onRequestStart: () => void calls.push('start'),
      onRequestEnd: () => void calls.push('end'),
      onShutdown: () => void calls.push('shutdown'),
    };
    const manager = makeManager([plugin]);
    await manager.onModuleInit();
    manager.dispatchRequestStart(makeProfile());
    manager.dispatchRequestEnd(makeProfile());
    await manager.onApplicationShutdown();
    expect(calls).toEqual(['register', 'start', 'end', 'shutdown']);
  });

  it('isolates plugin failures', async () => {
    const good: DebugPlugin = { name: 'good', onRequestStart: jest.fn() };
    const bad: DebugPlugin = {
      name: 'bad',
      onRequestStart: () => {
        throw new Error('kaboom');
      },
    };
    const manager = makeManager([bad, good]);
    await manager.onModuleInit();
    expect(() => manager.dispatchRequestStart(makeProfile())).not.toThrow();
    expect(good.onRequestStart).toHaveBeenCalled();
  });

  it('skips plugins whose register throws', async () => {
    const broken: DebugPlugin = {
      name: 'broken',
      register: () => {
        throw new Error('nope');
      },
    };
    const ok: DebugPlugin = { name: 'ok' };
    const manager = makeManager([broken, ok]);
    await manager.onModuleInit();
    expect(manager.getPlugins().map((plugin) => plugin.name)).toEqual(['ok']);
  });

  it('auto-registers the memory plugin when captureMemory is on', async () => {
    const manager = makeManager([], true);
    await manager.onModuleInit();
    expect(manager.getPlugins().map((plugin) => plugin.name)).toContain('memory');
    await manager.onApplicationShutdown();
  });
});
