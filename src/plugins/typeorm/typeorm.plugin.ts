import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';

const INSTRUMENTED = Symbol('nest-debug-panel:typeorm-instrumented');

interface QueryRunnerLike {
  query: (...args: unknown[]) => Promise<unknown>;
  [INSTRUMENTED]?: boolean;
}

interface DataSourceLike {
  createQueryRunner: (...args: unknown[]) => QueryRunnerLike;
  [INSTRUMENTED]?: boolean;
}

/**
 * TypeORM adapter. Every query — repositories, query builders, raw
 * `dataSource.query()` — ultimately executes through a `QueryRunner`, so we
 * wrap `createQueryRunner` and time `runner.query(sql, params)`. Runs in the
 * caller's async context, so events land on the right request automatically.
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
  private readonly pendingSources: DataSourceLike[] = [];

  constructor(private readonly pluginOptions: { dataSources?: unknown[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const source of [
      ...(this.pluginOptions.dataSources ?? []),
      ...this.pendingSources.splice(0),
    ]) {
      this.instrument(source as DataSourceLike);
    }
  }

  /** Instrument a DataSource (or anything exposing `createQueryRunner`). */
  attach(dataSource: unknown): void {
    if (this.context) this.instrument(dataSource as DataSourceLike);
    else this.pendingSources.push(dataSource as DataSourceLike);
  }

  private instrument(dataSource: DataSourceLike): void {
    if (!dataSource || typeof dataSource.createQueryRunner !== 'function' || dataSource[INSTRUMENTED]) {
      return;
    }
    dataSource[INSTRUMENTED] = true;
    const original = dataSource.createQueryRunner.bind(dataSource);
    const plugin = this;
    dataSource.createQueryRunner = function instrumentedCreateQueryRunner(...args: unknown[]): QueryRunnerLike {
      const runner = original(...args);
      try {
        plugin.instrumentRunner(runner);
      } catch {
        /* fail-open: an uninstrumented runner still works */
      }
      return runner;
    };
  }

  private instrumentRunner(runner: QueryRunnerLike): void {
    if (!runner || typeof runner.query !== 'function' || runner[INSTRUMENTED]) return;
    runner[INSTRUMENTED] = true;
    const original = runner.query.bind(runner);
    const plugin = this;
    runner.query = async function instrumentedQuery(...args: unknown[]): Promise<unknown> {
      const recorder = plugin.context?.recorder;
      if (!recorder?.isActive()) return original(...args);
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
