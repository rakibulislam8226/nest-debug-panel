import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';
import type { RequestProfile } from '../../interfaces/profile.interface';
import { PrismaCorrelator } from './prisma-correlator';

/** Shape of Prisma's `query` log event (requires `log: [{ emit: 'event', level: 'query' }]`). */
export interface PrismaQueryEventLike {
  timestamp?: Date;
  query: string;
  params?: string;
  duration: number;
  target?: string;
}

export interface PrismaClientLike {
  $on?(event: 'query', callback: (event: PrismaQueryEventLike) => void): void;
}

interface PrismaOperationArgs {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

interface PrismaMiddlewareParams {
  model?: string;
  action?: string;
}

/** Marks a client whose query events are already subscribed (any plugin instance). */
const ATTACHED = Symbol.for('nest-debug-panel:prisma-attached');
/** Marks a client whose operations are already hooked in place. */
const IN_PLACE = Symbol.for('nest-debug-panel:prisma-in-place');
/** Marks a driver adapter (factory or queryable) whose query methods are already wrapped. */
const ADAPTER_WRAPPED = Symbol.for('nest-debug-panel:prisma-adapter-wrapped');

interface InstrumentablePrisma extends PrismaClientLike {
  [ATTACHED]?: boolean;
  [IN_PLACE]?: boolean;
  $use?: (middleware: (params: PrismaMiddlewareParams, next: (params: PrismaMiddlewareParams) => Promise<unknown>) => Promise<unknown>) => void;
  _request?: (params: unknown) => Promise<unknown>;
}

/** A query as handed to a Prisma driver adapter: raw SQL text plus positional args. */
interface AdapterQuery {
  sql?: string;
  args?: unknown[];
}

/** The queryable a driver adapter's `connect()` returns (and its transactions). */
interface AdapterQueryable {
  queryRaw?: (query: AdapterQuery) => Promise<unknown>;
  executeRaw?: (query: AdapterQuery) => Promise<unknown>;
  startTransaction?: (...args: unknown[]) => Promise<AdapterQueryable>;
  [ADAPTER_WRAPPED]?: boolean;
}

/** The driver-adapter *factory* passed to `new PrismaClient({ adapter })` (Prisma 7+). */
interface AdapterFactory {
  connect: (...args: unknown[]) => Promise<AdapterQueryable>;
  [ADAPTER_WRAPPED]?: boolean;
}

/** A Prisma client we can drive a reconnect on to activate driver-adapter capture. */
interface ReconnectablePrisma {
  _engineConfig?: { adapter?: AdapterFactory };
  $connect?: () => Promise<unknown>;
  $disconnect?: () => Promise<unknown>;
}

/** SQL statements that are pure transaction control — noise in the query list. */
const TX_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|DEALLOCATE)\b/i;

/** Upper bound on the bootstrap reconnect that activates driver-adapter capture. */
const RECONNECT_TIMEOUT_MS = 8000;

/** Resolve when `promise` settles or after `ms`, whichever comes first (never rejects on timeout). */
function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function serializeAdapterArgs(args: unknown[] | undefined): string | undefined {
  if (!args || args.length === 0) return undefined;
  try {
    const json = JSON.stringify(args);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Prisma adapter. Capture modes, from most to least automatic:
 *
 * 1. `instrument(client)` — hooks the client **in place** (used by
 *    auto-instrumentation), no `log` option or code changes required. Captures
 *    raw SQL by wrapping the driver adapter (Prisma 7+); on older Prisma it
 *    subscribes to raw `query` log events instead. Also wraps the operation
 *    path (`$use` on Prisma ≤5, else the internal `_request`) to tag each
 *    query with its model/operation and record an ORM-level fallback.
 * 2. `attach(client)` — only subscribes to raw `query` log events. Requires
 *    the client to be created with `log: [{ emit: 'event', level: 'query' }]`.
 * 3. `extension()` — a Prisma client extension (`prisma.$extends(...)`), the
 *    guaranteed-stable hook across Prisma versions. Ties raw SQL to the right
 *    request, adds timeline marks, records ORM-level events as fallback.
 *
 * ```ts
 * export const prismaPlugin = new PrismaPlugin();
 * // DebugModule.forRoot({ plugins: [prismaPlugin] })
 * const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
 * prismaPlugin.attach(client);
 * export const db = client.$extends(prismaPlugin.extension());
 * ```
 */
export class PrismaPlugin implements DebugPlugin {
  readonly name = 'prisma';
  private context?: DebugPluginContext;
  private readonly correlator = new PrismaCorrelator();
  private readonly pendingClients: PrismaClientLike[] = [];
  private readonly pendingInstrument: unknown[] = [];
  /** Clients whose driver adapter was wrapped and now need a reconnect to activate it. */
  private readonly reconnectQueue: ReconnectablePrisma[] = [];
  /**
   * Per-operation context. Unlike the correlator's stack, an async-local store
   * follows each operation's own async chain, so concurrent operations
   * (`Promise.all([findMany, count])`) tag their raw SQL correctly instead of
   * both resolving to whichever token happens to be on top of the stack.
   */
  private readonly opContext = new AsyncLocalStorage<{
    profile: RequestProfile;
    model?: string;
    operation?: string;
    /** Set once this operation's raw SQL is captured, so the fallback stays quiet. */
    captured?: boolean;
  }>();

  constructor(private readonly pluginOptions: { client?: PrismaClientLike } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    if (this.pluginOptions.client) this.listen(this.pluginOptions.client);
    for (const client of this.pendingClients.splice(0)) this.listen(client);
    for (const client of this.pendingInstrument.splice(0)) {
      this.hookInPlace(client);
      this.setupRawCapture(client);
    }
  }

  /** Subscribe to a client's raw `query` log events. Safe to call before or after bootstrap. */
  attach(client: PrismaClientLike): void {
    if (this.context) this.listen(client);
    else this.pendingClients.push(client);
  }

  /**
   * Fully instrument a client in place, with zero changes to how the client is
   * created or used. Captures raw SQL by wrapping the driver adapter (Prisma
   * 7+) when present — no `log` option needed — and otherwise falls back to
   * raw `query` log events. Also hooks the operation path for model/operation
   * tagging and a last-resort ORM-level fallback.
   */
  instrument(client: unknown): void {
    if (this.context) {
      this.hookInPlace(client);
      this.setupRawCapture(client);
    } else {
      this.pendingInstrument.push(client);
    }
  }

  /**
   * Reconnect every client whose driver adapter we wrapped. A Prisma client
   * calls `adapter.connect()` exactly once and caches the queryable, so a
   * client that already connected (e.g. in `onModuleInit`) won't pick up our
   * wrapper until it reconnects. Safe to run at bootstrap, before traffic.
   * Fail-open: a client that resists reconnecting just keeps working.
   */
  async flushReconnects(): Promise<void> {
    for (const client of this.reconnectQueue.splice(0)) {
      try {
        // Bounded so a slow/unreachable database can never hang bootstrap. If
        // the reconnect is still in flight when the timeout fires, Prisma will
        // finish (or lazily reconnect on the next query) through the wrapper.
        await withTimeout(
          (async () => {
            await client.$disconnect?.();
            await client.$connect?.();
          })(),
          RECONNECT_TIMEOUT_MS,
        );
      } catch {
        /* fail-open: capture may be partial, but the app is unaffected */
      }
    }
  }

  /** True if any wrapped client is awaiting a reconnect to activate capture. */
  hasPendingReconnects(): boolean {
    return this.reconnectQueue.length > 0;
  }

  /** A Prisma client extension that scopes queries to the active request. */
  extension(): { name: string; query: { $allOperations: (args: PrismaOperationArgs) => Promise<unknown> } } {
    const plugin = this;
    return {
      name: 'nest-debug-panel-prisma',
      query: {
        $allOperations({ model, operation, args, query }: PrismaOperationArgs): Promise<unknown> {
          return plugin.runOperation(model, operation, () => query(args));
        },
      },
    };
  }

  /**
   * Wrap the client's operation path so every query runs through
   * {@link runOperation}. Prefers `$use` middleware (Prisma 2–5), falls back
   * to the internal `_request` method (also patched by Prisma's own OTel
   * instrumentation package). Both run inside the caller's async context.
   */
  private hookInPlace(client: unknown): void {
    const target = client as InstrumentablePrisma;
    if (!target || target[IN_PLACE]) return;
    const plugin = this;
    try {
      if (typeof target.$use === 'function') {
        target[IN_PLACE] = true;
        target.$use((params, next) =>
          plugin.runOperation(params?.model, params?.action, () => next(params)),
        );
        return;
      }
      if (typeof target._request === 'function') {
        target[IN_PLACE] = true;
        const original = target._request.bind(target);
        target._request = (params: unknown) => {
          const p = params as PrismaMiddlewareParams;
          return plugin.runOperation(p?.model, p?.action, () => original(params));
        };
      }
    } catch {
      /* fail-open: client keeps working uninstrumented */
    }
  }

  /**
   * Choose the best raw-SQL capture path for a client:
   *   - Prisma 7+ driver adapter present → wrap it (zero config, most reliable).
   *   - otherwise → subscribe to raw `query` log events (needs the `log` option).
   * Only one path is used, so queries are never recorded twice.
   */
  private setupRawCapture(client: unknown): void {
    if (this.instrumentDriverAdapter(client)) {
      this.reconnectQueue.push(client as ReconnectablePrisma);
      return;
    }
    this.listen(client as PrismaClientLike);
  }

  /**
   * Wrap a Prisma driver adapter (Prisma 7+) so every SQL statement it runs is
   * captured — no `log: [{ emit: 'event', level: 'query' }]` required. The
   * client holds the adapter *factory* at `_engineConfig.adapter`; its
   * `connect()` returns the queryable that actually runs `queryRaw` /
   * `executeRaw`. We wrap `connect()` to wrap each queryable (and its
   * transactions). Returns true when a factory was wrapped.
   */
  private instrumentDriverAdapter(client: unknown): boolean {
    const factory = (client as ReconnectablePrisma)?._engineConfig?.adapter;
    if (!factory || typeof factory.connect !== 'function' || factory[ADAPTER_WRAPPED]) return false;
    factory[ADAPTER_WRAPPED] = true;
    const plugin = this;
    const original = factory.connect.bind(factory);
    factory.connect = async (...args: unknown[]): Promise<AdapterQueryable> => {
      const queryable = await original(...args);
      // Never let instrumentation break the connection itself.
      try {
        return plugin.wrapQueryable(queryable) as AdapterQueryable;
      } catch {
        return queryable;
      }
    };
    return true;
  }

  /** Wrap a queryable's `queryRaw`/`executeRaw` (and transactions) to record SQL. Idempotent. */
  private wrapQueryable(queryable: AdapterQueryable | undefined): AdapterQueryable | undefined {
    if (!queryable || queryable[ADAPTER_WRAPPED]) return queryable;
    queryable[ADAPTER_WRAPPED] = true;
    const plugin = this;
    for (const method of ['queryRaw', 'executeRaw'] as const) {
      const fn = queryable[method];
      if (typeof fn !== 'function') continue;
      const original = fn.bind(queryable);
      queryable[method] = async (query: AdapterQuery): Promise<unknown> => {
        const start = performance.now();
        const startedAt = Date.now();
        try {
          return await original(query);
        } finally {
          // Recording must never alter the query's result or throw over it.
          try {
            plugin.recordAdapterQuery(query, performance.now() - start, startedAt);
          } catch {
            /* fail-open: capture failure is invisible to the caller */
          }
        }
      };
    }
    if (typeof queryable.startTransaction === 'function') {
      const original = queryable.startTransaction.bind(queryable);
      queryable.startTransaction = async (...args: unknown[]): Promise<AdapterQueryable> => {
        const tx = await original(...args);
        try {
          return plugin.wrapQueryable(tx) as AdapterQueryable;
        } catch {
          return tx;
        }
      };
    }
    return queryable;
  }

  /** Record one adapter-level SQL statement against the active request. */
  private recordAdapterQuery(query: AdapterQuery, durationMs: number, startedAt: number): void {
    const recorder = this.context?.recorder;
    if (!recorder) return;
    const sql = query?.sql ?? '';
    if (TX_CONTROL.test(sql)) return; // skip BEGIN/COMMIT/SAVEPOINT noise
    // The async-local operation context identifies the owning operation
    // accurately, even for concurrent operations. Outside a request there is
    // no store and no active profile, so background queries are ignored.
    const op = this.opContext.getStore();
    const profile = op?.profile ?? recorder.getProfile();
    if (!profile) return;
    if (op) op.captured = true; // suppress this operation's ORM-level fallback
    recorder.recordSql(
      {
        source: 'prisma',
        model: op?.model,
        operation: op?.operation,
        sql,
        params: serializeAdapterArgs(query?.args),
        durationMs,
        startedAt,
      },
      profile,
    );
  }

  /** Time one ORM operation, correlate raw SQL events, record a fallback event. */
  private runOperation(
    model: string | undefined,
    operation: string | undefined,
    execute: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    const recorder = this.context?.recorder;
    const profile = recorder?.getProfile();
    if (!recorder || !profile) return Promise.resolve(execute());

    const store: { profile: RequestProfile; model?: string; operation?: string; captured?: boolean } = {
      profile,
      model,
      operation,
    };
    const token = this.correlator.begin(profile, model, operation);
    const start = performance.now();
    const finish = (): void => {
      const durationMs = performance.now() - start;
      this.correlator.end(token);
      const label = [model, operation].filter(Boolean).join('.') || 'operation';
      recorder.mark(`Prisma ${label}`, durationMs);
      // Synthesize an ORM-level row only when this operation produced no raw
      // SQL by any means — driver-adapter capture (`store.captured`) or query
      // log events (`token.attached`). Otherwise it would be a phantom row.
      if (!store.captured && token.attached === 0) {
        recorder.recordSql({ source: 'prisma', model, operation, sql: label, durationMs }, profile);
      }
    };
    // Run the operation inside its own async-local context so any raw SQL it
    // emits is tagged with this exact model/operation, even under concurrency.
    return this.opContext.run(store, () =>
      Promise.resolve(execute()).then(
        (result) => {
          finish();
          return result;
        },
        (error) => {
          finish();
          throw error;
        },
      ),
    );
  }

  private listen(client: PrismaClientLike): void {
    const target = client as InstrumentablePrisma;
    if (!target || target[ATTACHED] || typeof target.$on !== 'function') return;
    target[ATTACHED] = true;
    try {
      target.$on('query', (event) => this.handleQueryEvent(event));
    } catch {
      /* client not configured for query events — fail open */
    }
  }

  private handleQueryEvent(event: PrismaQueryEventLike): void {
    const recorder = this.context?.recorder;
    if (!recorder) return;
    const token = this.correlator.resolve();
    const profile = recorder.getProfile() ?? token?.profile;
    if (!profile) return;
    // When the raw event belongs to a known ORM operation, tag it with the
    // model/operation so the panel shows raw SQL *and* its ORM context
    // (like Laravel Telescope / Django Silk), not one or the other.
    const owner = token && token.profile === profile ? token : undefined;
    if (owner) owner.attached += 1;
    recorder.recordSql(
      {
        source: 'prisma',
        model: owner?.model,
        operation: owner?.operation,
        sql: event.query,
        params: event.params,
        durationMs: event.duration,
        startedAt: event.timestamp instanceof Date ? event.timestamp.getTime() : undefined,
      },
      profile,
    );
  }
}

/**
 * Whether a Prisma client will emit raw `query` events — i.e. it was created
 * with a query-level log (`log: [{ emit: 'event', level: 'query' }]`). Prisma
 * exposes this as `_engineConfig.logQueries`; reading it is best-effort and
 * fail-open (unknown shape → assume enabled, so we never nag falsely).
 */
export function prismaLogsRawQueries(client: unknown): boolean {
  try {
    const config = (client as { _engineConfig?: { logQueries?: unknown } })?._engineConfig;
    // Unknown internal shape → stay quiet (never nag on a client we can't read).
    if (!config || typeof config !== 'object') return true;
    return config.logQueries === true;
  } catch {
    return true;
  }
}
