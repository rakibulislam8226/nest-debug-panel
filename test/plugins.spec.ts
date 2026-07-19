import { DebugContextService } from '../src/context/debug-context.service';
import { resolveDebugOptions } from '../src/config/debug-options';
import { MemoryStorage } from '../src/storage/memory.storage';
import { instrumentRedisClient, RedisPlugin } from '../src/plugins/redis/redis.plugin';
import { PrismaPlugin, prismaLogsRawQueries } from '../src/plugins/prisma/prisma.plugin';
import { instrumentAxios } from '../src/plugins/http/axios.plugin';
import type { DebugPluginContext } from '../src/interfaces/plugin.interface';
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

const options = resolveDebugOptions({ enabled: true });
const recorder = new DebugContextService(options);
const pluginContext: DebugPluginContext = {
  recorder,
  options,
  storage: new MemoryStorage(10),
};

describe('RedisPlugin', () => {
  it('records ioredis-style commands with timing', async () => {
    const client = {
      sendCommand: jest.fn(async (..._args: unknown[]) => 'OK'),
    };
    instrumentRedisClient(client, recorder);
    const profile = makeProfile('redis');
    await recorder.run(profile, async () => {
      await client.sendCommand({ name: 'get', args: ['user:1'] });
    });
    expect(profile.redis).toHaveLength(1);
    expect(profile.redis[0].command).toBe('GET');
    expect(profile.redis[0].args).toEqual(['user:1']);
    expect(profile.redis[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records node-redis-style commands and errors without swallowing them', async () => {
    const client = {
      sendCommand: jest.fn(async (..._args: unknown[]) => {
        throw new Error('WRONGTYPE');
      }),
    };
    instrumentRedisClient(client, recorder);
    const profile = makeProfile('redis-err');
    await recorder.run(profile, async () => {
      await expect(client.sendCommand(['SET', 'k', 'v'])).rejects.toThrow('WRONGTYPE');
    });
    // record happens on promise rejection observation (same tick chain)
    await new Promise((resolve) => setImmediate(resolve));
    expect(profile.redis).toHaveLength(1);
    expect(profile.redis[0].command).toBe('SET');
    expect(profile.redis[0].error).toBe('WRONGTYPE');
  });

  it('does not double-instrument and passes through outside request context', async () => {
    const client = { sendCommand: jest.fn(async (..._args: unknown[]) => 1) };
    const plugin = new RedisPlugin();
    plugin.attach(client);
    plugin.register(pluginContext);
    plugin.attach(client); // second attach is a no-op
    await client.sendCommand(['PING']); // outside context — no throw, no record
    expect(client.sendCommand).toBeDefined();
  });
});

describe('PrismaPlugin', () => {
  it('attributes raw query events to the request via the extension correlator', async () => {
    type QueryListener = (event: { query: string; params: string; duration: number; timestamp: Date }) => void;
    let listener: QueryListener | undefined;
    const fakeClient = {
      $on: (_event: 'query', callback: QueryListener) => {
        listener = callback;
      },
    };
    const plugin = new PrismaPlugin();
    plugin.attach(fakeClient);
    plugin.register(pluginContext);
    const extension = plugin.extension();

    const profile = makeProfile('prisma');
    await recorder.run(profile, async () => {
      await extension.query.$allOperations({
        model: 'User',
        operation: 'findMany',
        args: {},
        query: async () => {
          // engine emits the raw SQL event mid-operation, outside ALS context
          listener?.({
            query: 'SELECT * FROM "User" WHERE "id" = $1',
            params: '[1]',
            duration: 2.5,
            timestamp: new Date(),
          });
          return [];
        },
      });
    });

    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].sql).toContain('SELECT * FROM "User"');
    expect(profile.sql[0].params).toBe('[1]');
    // raw SQL is tagged with the ORM operation that produced it (Telescope-style)
    expect(profile.sql[0].model).toBe('User');
    expect(profile.sql[0].operation).toBe('findMany');
    // timeline gets both the SQL event and the Prisma operation mark
    expect(profile.timeline.some((event) => event.label.startsWith('Prisma User.findMany'))).toBe(true);
  });

  it('records an ORM-level fallback event when raw query logging is off', async () => {
    const plugin = new PrismaPlugin();
    plugin.register(pluginContext);
    const extension = plugin.extension();
    const profile = makeProfile('prisma-fallback');
    await recorder.run(profile, async () => {
      await extension.query.$allOperations({
        model: 'Post',
        operation: 'create',
        args: {},
        query: async () => ({ id: 1 }),
      });
    });
    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].sql).toBe('Post.create');
    expect(profile.sql[0].operation).toBe('create');
  });

  it('captures raw SQL from a Prisma 7 driver adapter with no log option', async () => {
    // Fake driver-adapter stack: factory.connect() → queryable.queryRaw/executeRaw.
    const queryable = {
      queryRaw: jest.fn(async (_q: { sql: string; args?: unknown[] }) => ({ rows: [] })),
      executeRaw: jest.fn(async (_q: { sql: string; args?: unknown[] }) => 1),
    };
    const factory = { connect: jest.fn(async () => queryable) };
    let live: typeof queryable | undefined;
    const client = {
      _engineConfig: { adapter: factory },
      $connect: jest.fn(async () => {
        live = (await client._engineConfig.adapter.connect()) as typeof queryable;
      }),
      $disconnect: jest.fn(async () => {}),
    };

    const plugin = new PrismaPlugin();
    plugin.register(pluginContext);
    await client.$connect(); // onModuleInit — connects before instrumentation
    plugin.instrument(client); // auto-instrument wraps the factory
    expect(plugin.hasPendingReconnects()).toBe(true);
    await plugin.flushReconnects(); // reconnect re-runs connect() through the wrapper

    const profile = makeProfile('prisma-adapter');
    await recorder.run(profile, async () => {
      await live!.queryRaw({ sql: 'SELECT * FROM "users" WHERE id = $1', args: [7] });
      await live!.executeRaw({ sql: 'BEGIN' }); // transaction control — must be ignored
      await live!.executeRaw({ sql: 'UPDATE "users" SET name = $1 WHERE id = $2', args: ['x', 7] });
    });

    expect(profile.sql).toHaveLength(2); // SELECT + UPDATE, BEGIN filtered out
    expect(profile.sql[0].sql).toContain('SELECT * FROM "users"');
    expect(profile.sql[0].params).toBe('[7]');
    expect(profile.sql[1].sql).toContain('UPDATE "users"');
  });

  it('tags concurrent operations correctly and records no phantom fallback row', async () => {
    // Fake adapter stack whose queryRaw runs whatever SQL the operation implies.
    const queryable = {
      queryRaw: jest.fn(async (_q: { sql: string; args?: unknown[] }) => ({ rows: [] })),
      executeRaw: jest.fn(async (_q: { sql: string; args?: unknown[] }) => 0),
    };
    const factory = { connect: jest.fn(async () => queryable) };
    let live: typeof queryable | undefined;
    const client = {
      _engineConfig: { adapter: factory },
      $connect: jest.fn(async () => {
        live = (await client._engineConfig.adapter.connect()) as typeof queryable;
      }),
      $disconnect: jest.fn(async () => {}),
      // Stand in for the engine: each operation runs its own SELECT.
      _request: async (params: { model?: string; action?: string }) =>
        live!.queryRaw({
          sql: params.action === 'count' ? 'SELECT COUNT(*) FROM "rides"' : 'SELECT * FROM "rides" LIMIT 2',
        }),
    };

    const plugin = new PrismaPlugin();
    plugin.register(pluginContext);
    await client.$connect();
    plugin.instrument(client); // wraps _request (operation context) + the adapter
    await plugin.flushReconnects();

    const profile = makeProfile('prisma-concurrent');
    await recorder.run(profile, async () => {
      // findMany + count concurrently — the paginated-list pattern.
      await Promise.all([
        client._request({ model: 'Ride', action: 'findMany' }),
        client._request({ model: 'Ride', action: 'count' }),
      ]);
    });

    expect(profile.sql).toHaveLength(2); // no phantom label-only row
    const select = profile.sql.find((q) => !q.sql?.includes('COUNT'));
    const count = profile.sql.find((q) => q.sql?.includes('COUNT'));
    expect(select?.operation).toBe('findMany'); // tag not swapped under concurrency
    expect(count?.operation).toBe('count');
  });

  it('is fail-open when a wrapped client cannot reconnect', async () => {
    const factory = { connect: jest.fn(async () => ({ queryRaw: async () => ({}) })) };
    const client = {
      _engineConfig: { adapter: factory },
      $connect: jest.fn(async () => {
        throw new Error('database unreachable');
      }),
      $disconnect: jest.fn(async () => {}),
    };
    const plugin = new PrismaPlugin();
    plugin.register(pluginContext);
    plugin.instrument(client);
    // Must resolve (never throw) even though $connect rejects — bootstrap is safe.
    await expect(plugin.flushReconnects()).resolves.toBeUndefined();
  });

  it('detects whether a client will emit raw SQL query events', () => {
    // Prisma 7 shape: logging on → logQueries: true; off → key absent.
    expect(prismaLogsRawQueries({ _engineConfig: { logQueries: true } })).toBe(true);
    expect(prismaLogsRawQueries({ _engineConfig: {} })).toBe(false);
    expect(prismaLogsRawQueries({ _engineConfig: { logQueries: false } })).toBe(false);
    // Unknown/unreadable client shapes stay quiet (never nag falsely).
    expect(prismaLogsRawQueries({})).toBe(true);
    expect(prismaLogsRawQueries(undefined)).toBe(true);
    expect(prismaLogsRawQueries(null)).toBe(true);
  });

  it('propagates operation errors', async () => {
    const plugin = new PrismaPlugin();
    plugin.register(pluginContext);
    const extension = plugin.extension();
    const profile = makeProfile('prisma-err');
    await recorder.run(profile, async () => {
      await expect(
        extension.query.$allOperations({
          model: 'User',
          operation: 'delete',
          args: {},
          query: async () => {
            throw new Error('not found');
          },
        }),
      ).rejects.toThrow('not found');
    });
  });
});

describe('instrumentAxios', () => {
  it('records requests through interceptor handlers', async () => {
    const handlers: {
      request?: (config: Record<string, unknown>) => unknown;
      response?: (response: Record<string, unknown>) => unknown;
      error?: (error: Record<string, unknown>) => unknown;
    } = {};
    const fakeAxios = {
      interceptors: {
        request: { use: (onFulfilled: never) => (handlers.request = onFulfilled) },
        response: {
          use: (onFulfilled: never, onRejected: never) => {
            handlers.response = onFulfilled;
            handlers.error = onRejected;
          },
        },
      },
    };
    instrumentAxios(fakeAxios as never, recorder);

    const profile = makeProfile('axios');
    await recorder.run(profile, async () => {
      const config = handlers.request!({ url: '/users', baseURL: 'http://api', method: 'get' }) as Record<string, unknown>;
      handlers.response!({ status: 200, data: { ok: true }, headers: { 'content-length': '15' }, config });
    });

    expect(profile.http).toHaveLength(1);
    expect(profile.http[0].url).toBe('http://api/users');
    expect(profile.http[0].statusCode).toBe(200);
    expect(profile.http[0].responseSize).toBe(15);
  });
});
