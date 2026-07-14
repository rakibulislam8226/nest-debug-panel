import { performance } from 'node:perf_hooks';
import type { DebugPlugin, DebugPluginContext } from '../../interfaces/plugin.interface';
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

interface InstrumentablePrisma extends PrismaClientLike {
  [ATTACHED]?: boolean;
  [IN_PLACE]?: boolean;
  $use?: (middleware: (params: PrismaMiddlewareParams, next: (params: PrismaMiddlewareParams) => Promise<unknown>) => Promise<unknown>) => void;
  _request?: (params: unknown) => Promise<unknown>;
}

/**
 * Prisma adapter. Capture modes, from most to least automatic:
 *
 * 1. `instrument(client)` — hooks the client **in place** (used by
 *    auto-instrumentation): subscribes to raw `query` log events and wraps
 *    the client's operation path via `$use` middleware or the internal
 *    `_request` method, whichever the installed Prisma version exposes.
 *    No `$extends`, no code changes.
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

  constructor(private readonly pluginOptions: { client?: PrismaClientLike } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    if (this.pluginOptions.client) this.listen(this.pluginOptions.client);
    for (const client of this.pendingClients.splice(0)) this.listen(client);
    for (const client of this.pendingInstrument.splice(0)) this.hookInPlace(client);
  }

  /** Subscribe to a client's raw `query` log events. Safe to call before or after bootstrap. */
  attach(client: PrismaClientLike): void {
    if (this.context) this.listen(client);
    else this.pendingClients.push(client);
  }

  /**
   * Fully instrument a client in place: raw query events + operation-level
   * capture, with zero changes to how the client is created or used.
   * Falls back gracefully on Prisma versions that expose neither hook.
   */
  instrument(client: unknown): void {
    this.attach(client as PrismaClientLike);
    if (this.context) this.hookInPlace(client);
    else this.pendingInstrument.push(client);
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

  /** Time one ORM operation, correlate raw SQL events, record a fallback event. */
  private runOperation(
    model: string | undefined,
    operation: string | undefined,
    execute: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    const recorder = this.context?.recorder;
    const profile = recorder?.getProfile();
    if (!recorder || !profile) return Promise.resolve(execute());

    const token = this.correlator.begin(profile);
    const start = performance.now();
    const finish = (): void => {
      const durationMs = performance.now() - start;
      this.correlator.end(token);
      const label = [model, operation].filter(Boolean).join('.') || 'operation';
      recorder.mark(`Prisma ${label}`, durationMs);
      // No raw query events arrived (query logging not enabled) —
      // record the ORM operation itself so the query still shows up.
      if (token.attached === 0) {
        recorder.recordSql({ source: 'prisma', model, operation, sql: label, durationMs }, profile);
      }
    };
    return Promise.resolve(execute()).then(
      (result) => {
        finish();
        return result;
      },
      (error) => {
        finish();
        throw error;
      },
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
    if (token && token.profile === profile) token.attached += 1;
    recorder.recordSql(
      {
        source: 'prisma',
        sql: event.query,
        params: event.params,
        durationMs: event.duration,
        startedAt: event.timestamp instanceof Date ? event.timestamp.getTime() : undefined,
      },
      profile,
    );
  }
}
