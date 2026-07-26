import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { RedisStorage, RedisClientLike } from '../src/storage/redis.storage';
import { MemoryStorage } from '../src/storage/memory.storage';
import { DebugModule, readRedisUrl } from '../src/debug.module';
import { DEBUG_STORAGE } from '../src/constants';
import type { DebugStorage } from '../src/interfaces/storage.interface';
import type { RequestProfile } from '../src/interfaces/profile.interface';

/** In-memory stand-in for a Redis server, shared by multiple RedisStorage instances. */
class FakeRedis implements RedisClientLike {
  private strings = new Map<string, string>();
  private lists = new Map<string, string[]>();

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) n++;
      if (this.lists.delete(key)) n++;
    }
    return n;
  }
  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values.slice().reverse());
    this.lists.set(key, list);
    return list.length;
  }
  async lrem(key: string, _count: number, value: string): Promise<number> {
    const list = this.lists.get(key);
    if (!list) return 0;
    const kept = list.filter((v) => v !== value);
    this.lists.set(key, kept);
    return list.length - kept.length;
  }
  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop === -1 ? undefined : stop + 1));
    return 'OK';
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) => this.strings.get(key) ?? null);
  }
}

function profile(id: string, kind?: 'http' | 'socket' | 'job'): RequestProfile {
  return {
    id,
    kind,
    method: kind === 'job' ? 'JOB' : 'GET',
    url: `/x/${id}`,
    queryParams: {},
    routeParams: {},
    startedAt: new Date(0).toISOString(),
    startedAtMs: 0,
    sql: [],
    redis: [],
    http: [],
    logs: [],
    timeline: [],
    custom: {},
    ...(kind === 'job' ? { job: { library: 'bullmq', queue: 'emails', jobName: `job-${id}` } } : {}),
  };
}

describe('RedisStorage', () => {
  it('shares captures across processes — a worker save is visible to the API panel', async () => {
    const server = new FakeRedis();
    // Two independent instances pointing at the same Redis = two processes.
    const worker = new RedisStorage({ client: server });
    const api = new RedisStorage({ client: server });

    await worker.save(profile('j1', 'job'));
    await api.save(profile('r1', 'http'));

    // The API panel lists everything, including the worker's job.
    const summaries = await api.list();
    expect(summaries.map((s) => s.id).sort()).toEqual(['j1', 'r1']);
    const jobRow = summaries.find((s) => s.id === 'j1');
    expect(jobRow?.kind).toBe('job');
    expect(jobRow?.queue).toBe('emails');

    // And the full profile is fetchable cross-instance.
    const full = await api.find('j1');
    expect(full?.job?.jobName).toBe('job-j1');
  });

  it('lists newest first', async () => {
    const store = new RedisStorage({ client: new FakeRedis() });
    await store.save(profile('a'));
    await store.save(profile('b'));
    await store.save(profile('c'));
    expect((await store.list()).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('caps retention at maxRequests, evicting the oldest', async () => {
    const store = new RedisStorage({ client: new FakeRedis(), maxRequests: 3 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) await store.save(profile(id));
    const ids = (await store.list()).map((s) => s.id);
    expect(ids).toEqual(['e', 'd', 'c']);
    expect(await store.count()).toBe(3);
  });

  it('re-saving a profile moves it to the front without duplicating', async () => {
    const store = new RedisStorage({ client: new FakeRedis() });
    await store.save(profile('a'));
    await store.save(profile('b'));
    await store.save(profile('a')); // updated
    expect((await store.list()).map((s) => s.id)).toEqual(['a', 'b']);
    expect(await store.count()).toBe(2);
  });

  it('serializes profiles with BigInt and circular refs, staying renderable', async () => {
    const store = new RedisStorage({ client: new FakeRedis() });
    const p = profile('x', 'job');
    (p.custom as Record<string, unknown>).big = BigInt(42);
    const circular: Record<string, unknown> = { name: 'c' };
    circular.self = circular;
    (p.custom as Record<string, unknown>).circular = circular;

    await store.save(p);
    const back = await store.find('x');
    expect(back).toBeDefined();
    expect(Array.isArray(back!.sql)).toBe(true); // detail page can render it
    expect(back!.custom.big).toBe('42'); // BigInt → string
    expect((back!.custom.circular as Record<string, unknown>).self).toBe('[Circular]');
  });

  it('falls back to a valid skeleton when a value cannot be serialized at all', async () => {
    const store = new RedisStorage({ client: new FakeRedis() });
    const p = profile('y');
    (p.custom as Record<string, unknown>).bomb = {
      toJSON() {
        throw new Error('nope');
      },
    };
    await store.save(p);
    const back = await store.find('y');
    expect(back).toBeDefined();
    expect(back!.id).toBe('y');
    // Structurally valid — arrays present so renderDetailPage won't crash.
    expect(Array.isArray(back!.timeline)).toBe(true);
    expect(Array.isArray(back!.sql)).toBe(true);
    // The row still lists (summary never depends on custom data).
    expect((await store.list()).some((s) => s.id === 'y')).toBe(true);
  });

  it('clear() removes everything', async () => {
    const store = new RedisStorage({ client: new FakeRedis() });
    await store.save(profile('a'));
    await store.save(profile('b'));
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(await store.count()).toBe(0);
    expect(await store.find('a')).toBeUndefined();
  });

  it('requires a client or a url', () => {
    expect(() => new RedisStorage({} as { client: RedisClientLike })).toThrow(/client.*url/);
  });

  it('gives a helpful error when `url` is used without ioredis installed', () => {
    // ioredis is not a dependency of this package, so the lazy require fails.
    expect(() => new RedisStorage({ url: 'redis://localhost:6379' })).toThrow(/ioredis/);
  });
});

describe('NEST_DEBUG_PANEL_STORAGE env var', () => {
  const keys = ['NEST_DEBUG_PANEL_STORAGE', 'NEST_DEBUG_PANEL_REDIS_URL', 'REDIS_URL'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function bootStorage(options: Record<string, unknown>): Promise<{
    storage: DebugStorage;
    close: () => Promise<void>;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [DebugModule.forRoot({ enabled: true, ...options })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { storage: app.get<DebugStorage>(DEBUG_STORAGE), close: () => app.close() };
  }

  it('defaults to in-memory when neither env nor option is set', async () => {
    const { storage, close } = await bootStorage({});
    expect(storage).toBeInstanceOf(MemoryStorage);
    await close();
  });

  it('=redis without a URL falls back to memory (fail-open)', async () => {
    process.env.NEST_DEBUG_PANEL_STORAGE = 'redis';
    const { storage, close } = await bootStorage({});
    expect(storage).toBeInstanceOf(MemoryStorage);
    await close();
  });

  it('=memory keeps the in-memory store', async () => {
    process.env.NEST_DEBUG_PANEL_STORAGE = 'memory';
    const { storage, close } = await bootStorage({});
    expect(storage).toBeInstanceOf(MemoryStorage);
    await close();
  });

  it('a storage instance in code wins over the env var', async () => {
    process.env.NEST_DEBUG_PANEL_STORAGE = 'redis';
    const custom = new MemoryStorage(5);
    const { storage, close } = await bootStorage({ storage: custom });
    expect(storage).toBe(custom);
    await close();
  });

  it('ignores an unrecognized value and uses the default', async () => {
    process.env.NEST_DEBUG_PANEL_STORAGE = 'postgres';
    const { storage, close } = await bootStorage({});
    expect(storage).toBeInstanceOf(MemoryStorage);
    await close();
  });
});

describe('readRedisUrl (connection resolution)', () => {
  const keys = [
    'NEST_DEBUG_PANEL_REDIS_URL',
    'REDIS_URL',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
    'REDIS_DB',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns undefined when nothing is configured', () => {
    expect(readRedisUrl()).toBeUndefined();
  });

  it('prefers an explicit URL', () => {
    process.env.NEST_DEBUG_PANEL_REDIS_URL = 'redis://panel:6380/1';
    process.env.REDIS_HOST = 'ignored';
    expect(readRedisUrl()).toBe('redis://panel:6380/1');
  });

  it('falls back to REDIS_URL', () => {
    process.env.REDIS_URL = 'redis://cache:6379';
    expect(readRedisUrl()).toBe('redis://cache:6379');
  });

  it('builds a URL from discrete REDIS_HOST/PORT/PASSWORD/DB (password encoded)', () => {
    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6390';
    process.env.REDIS_PASSWORD = 'p@ss:word';
    process.env.REDIS_DB = '3';
    expect(readRedisUrl()).toBe('redis://:p%40ss%3Aword@redis.internal:6390/3');
  });

  it('builds from host alone, defaulting the port', () => {
    process.env.REDIS_HOST = 'localhost';
    expect(readRedisUrl()).toBe('redis://localhost:6379');
  });
});
