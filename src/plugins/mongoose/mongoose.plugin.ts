import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';

interface MongooseLike {
  set: (key: 'debug', value: unknown) => unknown;
}

/**
 * Mongoose adapter. Uses `mongoose.set('debug', cb)`, which fires for every
 * collection operation with the collection name, method and arguments. The
 * hook fires when the operation is dispatched (inside the request's async
 * context) but does not report execution time, so `durationMs` is 0 —
 * operation counts, arguments, duplicates and N+1 detection still work.
 *
 * ```ts
 * const mongoosePlugin = new MongoosePlugin();
 * // DebugModule.forRoot({ plugins: [mongoosePlugin] })
 * mongoosePlugin.attach(mongoose); // the imported mongoose instance
 * ```
 */
export class MongoosePlugin implements DebugPlugin {
  readonly name = 'mongoose';
  private context?: DebugPluginContext;
  private readonly pendingInstances: MongooseLike[] = [];

  constructor(private readonly pluginOptions: { instances?: unknown[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const instance of [
      ...(this.pluginOptions.instances ?? []),
      ...this.pendingInstances.splice(0),
    ]) {
      this.instrument(instance as MongooseLike);
    }
  }

  attach(mongoose: unknown): void {
    if (this.context) this.instrument(mongoose as MongooseLike);
    else this.pendingInstances.push(mongoose as MongooseLike);
  }

  private instrument(mongoose: MongooseLike): void {
    if (!mongoose || typeof mongoose.set !== 'function') return;
    const plugin = this;
    mongoose.set('debug', (collection: unknown, method: unknown, ...args: unknown[]): void => {
      const recorder = plugin.context?.recorder;
      if (!recorder?.isActive()) return;
      const model = String(collection);
      const operation = String(method);
      recorder.recordSql({
        source: 'mongoose',
        model,
        operation,
        sql: `${model}.${operation}(${formatArguments(args)})`,
        durationMs: 0, // mongoose's debug hook does not expose timing
      });
    });
  }
}

function formatArguments(args: unknown[]): string {
  try {
    const json = args.map((arg) => JSON.stringify(arg) ?? 'undefined').join(', ');
    return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    return '…';
  }
}
