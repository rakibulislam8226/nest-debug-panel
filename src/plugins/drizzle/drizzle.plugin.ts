import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';

/** Shape of Drizzle's `Logger` interface — structurally compatible, no import needed. */
export interface DrizzleLoggerLike {
  logQuery(query: string, params: unknown[]): void;
}

/**
 * Drizzle adapter. Drizzle exposes a logger hook on `drizzle(client, { logger })`
 * that receives every query with its parameters. The hook fires at dispatch
 * time inside the request's async context; it does not expose timing, so
 * `durationMs` is 0 — counts, duplicates and N+1 detection still work.
 *
 * ```ts
 * const drizzlePlugin = new DrizzlePlugin();
 * // DebugModule.forRoot({ plugins: [drizzlePlugin] })
 * const db = drizzle(pool, { logger: drizzlePlugin.logger() });
 * ```
 */
export class DrizzlePlugin implements DebugPlugin {
  readonly name = 'drizzle';
  private context?: DebugPluginContext;

  register(context: DebugPluginContext): void {
    this.context = context;
  }

  /** A Drizzle-compatible logger that records every query. */
  logger(): DrizzleLoggerLike {
    const plugin = this;
    return {
      logQuery(query: string, params: unknown[]): void {
        const recorder = plugin.context?.recorder;
        if (!recorder?.isActive()) return;
        recorder.recordSql({
          source: 'drizzle',
          sql: query,
          params: serializeParams(params),
          durationMs: 0, // drizzle's logger hook does not expose timing
        });
      },
    };
  }
}

function serializeParams(params: unknown[]): string | undefined {
  if (!params || params.length === 0) return undefined;
  try {
    const json = JSON.stringify(params);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return '[unserializable]';
  }
}
