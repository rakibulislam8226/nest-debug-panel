import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';

const INSTRUMENTED = Symbol('nest-debug-panel:sequelize-instrumented');

interface SequelizeLike {
  options?: {
    benchmark?: boolean;
    logging?: unknown;
  };
  [INSTRUMENTED]?: boolean;
}

/**
 * Sequelize adapter. Enables `benchmark` and wraps the `logging` callback,
 * which Sequelize invokes per query with the SQL and (when benchmarking) the
 * execution time in ms. A previously configured `logging` function keeps
 * working — we call it first.
 *
 * ```ts
 * const sequelizePlugin = new SequelizePlugin();
 * // DebugModule.forRoot({ plugins: [sequelizePlugin] })
 * sequelizePlugin.attach(sequelize);
 * ```
 */
export class SequelizePlugin implements DebugPlugin {
  readonly name = 'sequelize';
  private context?: DebugPluginContext;
  private readonly pendingInstances: SequelizeLike[] = [];

  constructor(private readonly pluginOptions: { instances?: unknown[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const instance of [
      ...(this.pluginOptions.instances ?? []),
      ...this.pendingInstances.splice(0),
    ]) {
      this.instrument(instance as SequelizeLike);
    }
  }

  attach(sequelize: unknown): void {
    if (this.context) this.instrument(sequelize as SequelizeLike);
    else this.pendingInstances.push(sequelize as SequelizeLike);
  }

  private instrument(sequelize: SequelizeLike): void {
    if (!sequelize?.options || sequelize[INSTRUMENTED]) return;
    sequelize[INSTRUMENTED] = true;
    const options = sequelize.options;
    options.benchmark = true;
    const previous = typeof options.logging === 'function' ? (options.logging as (...args: unknown[]) => void) : undefined;
    const plugin = this;
    options.logging = (sql: unknown, timing?: unknown, ...rest: unknown[]): void => {
      try {
        previous?.(sql, timing, ...rest);
      } catch {
        /* user logger errors are not ours to propagate */
      }
      const recorder = plugin.context?.recorder;
      if (!recorder?.isActive()) return;
      recorder.recordSql({
        source: 'sequelize',
        // strip Sequelize's "Executed (default): " prefix
        sql: String(sql).replace(/^Execut(?:ed|ing)\s*\([^)]*\):\s*/i, ''),
        durationMs: typeof timing === 'number' && Number.isFinite(timing) ? timing : 0,
      });
    };
  }
}
