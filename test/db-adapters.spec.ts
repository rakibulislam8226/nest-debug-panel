import { DebugContextService } from '../src/context/debug-context.service';
import { resolveDebugOptions } from '../src/config/debug-options';
import { MemoryStorage } from '../src/storage/memory.storage';
import { TypeOrmPlugin } from '../src/plugins/typeorm/typeorm.plugin';
import { SequelizePlugin } from '../src/plugins/sequelize/sequelize.plugin';
import { MongoosePlugin } from '../src/plugins/mongoose/mongoose.plugin';
import { DrizzlePlugin } from '../src/plugins/drizzle/drizzle.plugin';
import { KnexPlugin } from '../src/plugins/knex/knex.plugin';
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

describe('TypeOrmPlugin', () => {
  it('times queries through wrapped query runners', async () => {
    const runner = { query: jest.fn(async (..._args: unknown[]) => [{ id: 1 }]) };
    const dataSource = { createQueryRunner: jest.fn((..._args: unknown[]) => runner) };
    const plugin = new TypeOrmPlugin();
    plugin.attach(dataSource);
    plugin.register(pluginContext);

    const profile = makeProfile('typeorm');
    await recorder.run(profile, async () => {
      const created = dataSource.createQueryRunner();
      await created.query('SELECT * FROM users WHERE id = $1', [7]);
    });

    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].source).toBe('typeorm');
    expect(profile.sql[0].sql).toBe('SELECT * FROM users WHERE id = $1');
    expect(profile.sql[0].params).toBe('[7]');
    expect(profile.sql[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records failed queries and rethrows', async () => {
    const runner = {
      query: jest.fn(async (..._args: unknown[]) => {
        throw new Error('syntax error');
      }),
    };
    const dataSource = { createQueryRunner: jest.fn((..._args: unknown[]) => runner) };
    const plugin = new TypeOrmPlugin({ dataSources: [dataSource] });
    plugin.register(pluginContext);

    const profile = makeProfile('typeorm-err');
    await recorder.run(profile, async () => {
      await expect(dataSource.createQueryRunner().query('SELECT boom')).rejects.toThrow('syntax error');
    });
    expect(profile.sql).toHaveLength(1);
  });

  it('passes through outside a request context', async () => {
    const runner = { query: jest.fn(async (..._args: unknown[]) => 'ok') };
    const dataSource = { createQueryRunner: jest.fn((..._args: unknown[]) => runner) };
    const plugin = new TypeOrmPlugin();
    plugin.register(pluginContext);
    plugin.attach(dataSource);
    await expect(dataSource.createQueryRunner().query('SELECT 1')).resolves.toBe('ok');
  });
});

describe('SequelizePlugin', () => {
  it('enables benchmark and records via the logging hook, preserving the user logger', () => {
    const userLogger = jest.fn();
    const sequelize = { options: { benchmark: false, logging: userLogger as unknown } };
    const plugin = new SequelizePlugin();
    plugin.attach(sequelize);
    plugin.register(pluginContext);

    expect(sequelize.options.benchmark).toBe(true);
    const profile = makeProfile('sequelize');
    recorder.run(profile, () => {
      (sequelize.options.logging as (sql: string, timing?: number) => void)(
        'Executed (default): SELECT * FROM "orders"',
        12.5,
      );
    });

    expect(userLogger).toHaveBeenCalled();
    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].sql).toBe('SELECT * FROM "orders"');
    expect(profile.sql[0].durationMs).toBe(12.5);
  });
});

describe('MongoosePlugin', () => {
  it('records collection operations from the debug hook', () => {
    let debugCallback: ((collection: unknown, method: unknown, ...args: unknown[]) => void) | undefined;
    const mongoose = {
      set: jest.fn((key: string, value: unknown) => {
        if (key === 'debug') debugCallback = value as typeof debugCallback;
      }),
    };
    const plugin = new MongoosePlugin();
    plugin.attach(mongoose);
    plugin.register(pluginContext);

    const profile = makeProfile('mongoose');
    recorder.run(profile, () => {
      debugCallback?.('users', 'find', { active: true }, { limit: 10 });
    });

    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].source).toBe('mongoose');
    expect(profile.sql[0].model).toBe('users');
    expect(profile.sql[0].operation).toBe('find');
    expect(profile.sql[0].sql).toContain('users.find({"active":true}');
  });
});

describe('DrizzlePlugin', () => {
  it('records queries through its logger', () => {
    const plugin = new DrizzlePlugin();
    plugin.register(pluginContext);
    const logger = plugin.logger();

    const profile = makeProfile('drizzle');
    recorder.run(profile, () => {
      logger.logQuery('select * from "users" where "id" = $1', [3]);
    });

    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].source).toBe('drizzle');
    expect(profile.sql[0].params).toBe('[3]');
  });

  it('is a no-op outside a request context', () => {
    const plugin = new DrizzlePlugin();
    plugin.register(pluginContext);
    expect(() => plugin.logger().logQuery('select 1', [])).not.toThrow();
  });
});

describe('KnexPlugin', () => {
  it('correlates query and query-response events, even off-context responses', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const knex = { on: jest.fn((event: string, cb: (...args: unknown[]) => void) => listeners.set(event, cb)) };
    const plugin = new KnexPlugin();
    plugin.attach(knex);
    plugin.register(pluginContext);

    const profile = makeProfile('knex');
    const query = { __knexQueryUid: 'q1', sql: 'select * from users where id = ?', bindings: [9] };
    recorder.run(profile, () => {
      listeners.get('query')?.(query);
    });
    // the response event fires outside the request context (driver callback)
    listeners.get('query-response')?.([{ id: 9 }], query);

    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].source).toBe('knex');
    expect(profile.sql[0].params).toBe('[9]');
    expect(profile.sql[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records errored queries via query-error', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const knex = { on: jest.fn((event: string, cb: (...args: unknown[]) => void) => listeners.set(event, cb)) };
    const plugin = new KnexPlugin({ instances: [knex] });
    plugin.register(pluginContext);

    const profile = makeProfile('knex-err');
    const query = { __knexQueryUid: 'q2', sql: 'select boom', bindings: [] };
    recorder.run(profile, () => listeners.get('query')?.(query));
    listeners.get('query-error')?.(new Error('bad sql'), query);

    expect(profile.sql).toHaveLength(1);
    expect(profile.sql[0].sql).toBe('select boom');
  });
});
