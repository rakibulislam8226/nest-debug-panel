import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';
import type { DebugRecorder } from '../../interfaces/recorder.interface';

const INSTRUMENTED = Symbol.for('nest-debug-panel:typeorm-instrumented');

interface QueryRunnerLike {
  query: (...args: unknown[]) => Promise<unknown>;
  [INSTRUMENTED]?: boolean;
}

interface DataSourceLike {
  createQueryRunner: (...args: unknown[]) => QueryRunnerLike;
  [INSTRUMENTED]?: boolean;
}

/**
 * Instrument a TypeORM DataSource in place. Every query — repositories, query
 * builders, raw `dataSource.query()` — ultimately executes through a
 * `QueryRunner`, so wrapping `createQueryRunner` times `runner.query(sql,
 * params)` for all of them. Runs in the caller's async context, so events
 * land on the right request automatically. Idempotent and fail-open.
 */
export function instrumentTypeOrmDataSource(dataSource: unknown, recorder: DebugRecorder): void {
  const source = dataSource as DataSourceLike | undefined;
  if (!source || typeof source.createQueryRunner !== 'function' || source[INSTRUMENTED]) return;
  source[INSTRUMENTED] = true;
  const original = source.createQueryRunner.bind(source);
  source.createQueryRunner = function instrumentedCreateQueryRunner(
    ...args: unknown[]
  ): QueryRunnerLike {
    const runner = original(...args);
    try {
      instrumentRunner(runner, recorder);
    } catch {
      /* fail-open: an uninstrumented runner still works */
    }
    return runner;
  };
}

function instrumentRunner(runner: QueryRunnerLike, recorder: DebugRecorder): void {
  if (!runner || typeof runner.query !== 'function' || runner[INSTRUMENTED]) return;
  runner[INSTRUMENTED] = true;
  const original = runner.query.bind(runner);
  runner.query = async function instrumentedQuery(...args: unknown[]): Promise<unknown> {
    if (!recorder.isActive()) return original(...args);
    const start = performance.now();
    const startedAt = Date.now();
    const record = (): void =>
      recorder.recordSql({
        source: 'typeorm',
        sql: typeof args[0] === 'string' ? args[0] : String(args[0]),
        params: serializeParams(args[1]),
        durationMs: performance.now() - start,
        startedAt,
      });
    try {
      const result = await original(...args);
      record();
      return result;
    } catch (error) {
      record();
      throw error;
    }
  };
}

function serializeParams(params: unknown): string | undefined {
  if (params === undefined || params === null) return undefined;
  try {
    const json = JSON.stringify(params);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return '[unserializable]';
  }
}

/**
 * TypeORM adapter plugin.
 *
 * ```ts
 * const typeormPlugin = new TypeOrmPlugin();
 * // DebugModule.forRoot({ plugins: [typeormPlugin] })
 * typeormPlugin.attach(dataSource); // after DataSource.initialize()
 * ```
 */
export class TypeOrmPlugin implements DebugPlugin {
  readonly name = 'typeorm';
  private context?: DebugPluginContext;
  private readonly pendingSources: unknown[] = [];

  constructor(private readonly pluginOptions: { dataSources?: unknown[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const source of [
      ...(this.pluginOptions.dataSources ?? []),
      ...this.pendingSources.splice(0),
    ]) {
      instrumentTypeOrmDataSource(source, context.recorder);
    }
  }

  /** Instrument a DataSource (or anything exposing `createQueryRunner`). */
  attach(dataSource: unknown): void {
    if (this.context) instrumentTypeOrmDataSource(dataSource, this.context.recorder);
    else this.pendingSources.push(dataSource);
  }
}
