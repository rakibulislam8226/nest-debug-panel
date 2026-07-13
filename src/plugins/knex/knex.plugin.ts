import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';
import type { RequestProfile } from '../../interfaces/profile.interface';

const INSTRUMENTED = Symbol('nest-debug-panel:knex-instrumented');

interface KnexQueryInfo {
  __knexQueryUid?: string;
  sql?: string;
  bindings?: unknown[];
}

interface KnexLike {
  on: (event: string, callback: (...args: never[]) => void) => unknown;
  [INSTRUMENTED]?: boolean;
}

/** Prevent unbounded growth if response events are ever lost. */
const MAX_PENDING = 1000;

/**
 * Knex adapter (also covers query builders layered on Knex, e.g. Objection.js
 * and Bookshelf). Uses Knex's `query` / `query-response` / `query-error`
 * events, correlated by `__knexQueryUid`. The `query` event fires inside the
 * request's async context, so the profile is captured there and the response
 * event (which may fire outside it) records against that profile.
 *
 * ```ts
 * const knexPlugin = new KnexPlugin();
 * // DebugModule.forRoot({ plugins: [knexPlugin] })
 * knexPlugin.attach(knex);
 * ```
 */
export class KnexPlugin implements DebugPlugin {
  readonly name = 'knex';
  private context?: DebugPluginContext;
  private readonly pendingInstances: KnexLike[] = [];

  constructor(private readonly pluginOptions: { instances?: unknown[] } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    for (const instance of [
      ...(this.pluginOptions.instances ?? []),
      ...this.pendingInstances.splice(0),
    ]) {
      this.instrument(instance as KnexLike);
    }
  }

  attach(knex: unknown): void {
    if (this.context) this.instrument(knex as KnexLike);
    else this.pendingInstances.push(knex as KnexLike);
  }

  private instrument(knex: KnexLike): void {
    if (!knex || typeof knex.on !== 'function' || knex[INSTRUMENTED]) return;
    knex[INSTRUMENTED] = true;

    const inFlight = new Map<string, { start: number; startedAt: number; profile: RequestProfile }>();
    const plugin = this;

    const finish = (query: KnexQueryInfo | undefined): void => {
      const uid = query?.__knexQueryUid;
      if (uid === undefined) return;
      const entry = inFlight.get(uid);
      if (!entry) return;
      inFlight.delete(uid);
      plugin.context?.recorder.recordSql(
        {
          source: 'knex',
          sql: String(query?.sql ?? ''),
          params: serializeBindings(query?.bindings),
          durationMs: performance.now() - entry.start,
          startedAt: entry.startedAt,
        },
        entry.profile,
      );
    };

    knex.on('query', ((query: KnexQueryInfo) => {
      const recorder = plugin.context?.recorder;
      const profile = recorder?.getProfile();
      if (!profile || query?.__knexQueryUid === undefined) return;
      if (inFlight.size >= MAX_PENDING) inFlight.clear();
      inFlight.set(query.__knexQueryUid, {
        start: performance.now(),
        startedAt: Date.now(),
        profile,
      });
    }) as (...args: never[]) => void);

    knex.on('query-response', ((_response: unknown, query: KnexQueryInfo) => finish(query)) as (
      ...args: never[]
    ) => void);
    knex.on('query-error', ((_error: unknown, query: KnexQueryInfo) => finish(query)) as (
      ...args: never[]
    ) => void);
  }
}

function serializeBindings(bindings: unknown[] | undefined): string | undefined {
  if (!bindings || bindings.length === 0) return undefined;
  try {
    const json = JSON.stringify(bindings);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return '[unserializable]';
  }
}
