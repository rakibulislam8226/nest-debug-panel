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

/**
 * Prisma adapter. Two complementary capture modes — use both for best results:
 *
 * 1. `attach(client)` — listens to Prisma `query` log events for **raw SQL,
 *    params and engine-measured duration**. Requires the client to be created
 *    with `log: [{ emit: 'event', level: 'query' }]`.
 * 2. `extension()` — a Prisma client extension (`prisma.$extends(plugin.extension())`)
 *    that runs inside the request's async context. It ties raw SQL events to
 *    the right request, adds `Prisma model.operation` timeline marks, and
 *    records an ORM-level fallback event when raw SQL events aren't enabled.
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

  constructor(private readonly pluginOptions: { client?: PrismaClientLike } = {}) {}

  register(context: DebugPluginContext): void {
    this.context = context;
    if (this.pluginOptions.client) this.listen(this.pluginOptions.client);
    for (const client of this.pendingClients.splice(0)) this.listen(client);
  }

  /** Subscribe to a client's raw `query` log events. Safe to call before or after bootstrap. */
  attach(client: PrismaClientLike): void {
    if (this.context) this.listen(client);
    else this.pendingClients.push(client);
  }

  /** A Prisma client extension that scopes queries to the active request. */
  extension(): { name: string; query: { $allOperations: (args: PrismaOperationArgs) => Promise<unknown> } } {
    const plugin = this;
    return {
      name: 'nest-debug-panel-prisma',
      query: {
        $allOperations({ model, operation, args, query }: PrismaOperationArgs): Promise<unknown> {
          const recorder = plugin.context?.recorder;
          const profile = recorder?.getProfile();
          if (!recorder || !profile) return query(args);

          const token = plugin.correlator.begin(profile);
          const start = performance.now();
          const finish = (): void => {
            const durationMs = performance.now() - start;
            plugin.correlator.end(token);
            const label = [model, operation].filter(Boolean).join('.');
            recorder.mark(`Prisma ${label}`, durationMs);
            // No raw query events arrived (query logging not enabled) —
            // record the ORM operation itself so the query still shows up.
            if (token.attached === 0) {
              recorder.recordSql(
                { source: 'prisma', model, operation, sql: label, durationMs },
                profile,
              );
            }
          };
          return Promise.resolve(query(args)).then(
            (result) => {
              finish();
              return result;
            },
            (error) => {
              finish();
              throw error;
            },
          );
        },
      },
    };
  }

  private listen(client: PrismaClientLike): void {
    client.$on?.('query', (event) => this.handleQueryEvent(event));
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
