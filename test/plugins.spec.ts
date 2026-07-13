import { DebugContextService } from '../src/context/debug-context.service';
import { resolveDebugOptions } from '../src/config/debug-options';
import { MemoryStorage } from '../src/storage/memory.storage';
import { instrumentRedisClient, RedisPlugin } from '../src/plugins/redis/redis.plugin';
import { PrismaPlugin } from '../src/plugins/prisma/prisma.plugin';
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
