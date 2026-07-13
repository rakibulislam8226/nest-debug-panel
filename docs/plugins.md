# Plugin development & extension guide

Everything in nest-debug-panel that touches an external system is a plugin. The core knows nothing about Prisma, Redis, or Axios — it only knows the `DebugPlugin` contract and the `DebugRecorder` API.

## The contract

```ts
import { DebugPlugin, DebugPluginContext, RequestProfile } from 'nest-debug-panel';

export class MyPlugin implements DebugPlugin {
  readonly name = 'my-plugin';

  /** Called once at bootstrap. Keep the context — it's your API surface. */
  register(context: DebugPluginContext): void | Promise<void> {
    this.recorder = context.recorder;  // write events
    this.options = context.options;    // resolved module options
    this.storage = context.storage;    // the active storage driver
  }

  /** Called at the start of every profiled request. */
  onRequestStart(profile: RequestProfile): void {}

  /** Called after the response, right before the profile is persisted. */
  onRequestEnd(profile: RequestProfile): void {}

  /** Called on application shutdown — undo monkey-patches here. */
  onShutdown(): void | Promise<void> {}
}
```

Register it:

```ts
DebugModule.forRoot({ plugins: [new MyPlugin()] });
```

Failures are isolated: a plugin that throws in any hook is logged and skipped; it can never break a request or other plugins.

## The recorder

`DebugRecorder` resolves the current request via `AsyncLocalStorage`, so you can call it from anywhere inside the request's async chain — patched clients, services, event handlers:

```ts
recorder.isActive()                          // are we inside a profiled request?
recorder.getProfile()                        // the live RequestProfile, or undefined
recorder.recordSql({ source, sql, params, durationMs, model?, operation?, transactionId? })
recorder.recordRedis({ command, args, durationMs, error? })
recorder.recordHttp({ source, method, url, statusCode, durationMs, requestSize?, responseSize? })
recorder.recordException(error)
recorder.mark('label', durationMs?)          // custom timeline entry
recorder.setCustom('key', value)             // free-form profile data
```

Every `record*` call also appends a timeline entry automatically. All calls no-op outside a request context, and respect the `captureSql` / `captureRedis` / `captureHttp` flags.

### Losing the async context

Some libraries emit events from engine threads or global emitters, **outside** the request's async context — `recorder.getProfile()` returns `undefined` there. Every `record*` method accepts an explicit target for this case:

```ts
recorder.recordSql(event, someProfile);
```

Look at `PrismaPlugin` for the full pattern: its client extension runs *inside* the context and registers a correlation token; the engine's `query` event handler runs *outside* it and resolves the token to find the right profile (`src/plugins/prisma/prisma-correlator.ts`).

## Worked example: a BullMQ plugin

```ts
import { DebugPlugin, DebugPluginContext } from 'nest-debug-panel';
import { performance } from 'node:perf_hooks';

export class BullMqPlugin implements DebugPlugin {
  readonly name = 'bullmq';
  private context?: DebugPluginContext;

  register(context: DebugPluginContext): void {
    this.context = context;
  }

  /** Call from wherever you create queues. */
  attachQueue(queue: { add: (...args: any[]) => Promise<unknown> }): void {
    const original = queue.add.bind(queue);
    const plugin = this;
    queue.add = async function (...args: unknown[]) {
      const recorder = plugin.context?.recorder;
      if (!recorder?.isActive()) return original(...args);
      const start = performance.now();
      try {
        return await original(...args);
      } finally {
        recorder.mark(`Queue add ${String(args[0])}`, performance.now() - start);
        recorder.setCustom('enqueuedJobs',
          ((recorder.getProfile()!.custom['enqueuedJobs'] as number) ?? 0) + 1);
      }
    };
  }
}
```

Conventions worth copying from the built-in plugins:

- **Idempotent patching** — guard with a `Symbol` so double-instrumentation is a no-op.
- **Never swallow errors** — observe promises (`result.then(record, record)`), return the original.
- **Pass through when inactive** — zero overhead outside profiled requests.
- **`attach()` before or after bootstrap** — queue targets until `register` runs.

## Writing a database adapter (TypeORM, Drizzle, Sequelize, Mongoose)

The core is ORM-agnostic; an adapter only needs to call `recorder.recordSql`. Hook points:

| ORM | Hook |
| --- | --- |
| TypeORM | custom `Logger` (`logQuery` receives SQL + params; pair with `QueryRunner` timing) or a wrapped `DataSource.query` |
| Drizzle | the `logger` option on `drizzle()` |
| Sequelize | `benchmark: true` + `logging: (sql, timingMs) => recorder.recordSql(...)` |
| Mongoose | `mongoose.set('debug', (coll, method, ...args) => ...)` |

If the hook runs inside the request's async chain (most do), you don't need correlation — just call `recordSql`. If it doesn't, use the correlator pattern from the Prisma adapter.

## Custom storage drivers

```ts
import { DebugStorage, RequestProfile, RequestSummary, toRequestSummary } from 'nest-debug-panel';

export class FileStorage implements DebugStorage {
  async save(profile: RequestProfile) { /* append JSON line, rotate at maxRequests */ }
  async find(id: string) { /* ... */ }
  async list(): Promise<RequestSummary[]> { /* newest first; use toRequestSummary() */ }
  async clear() { /* ... */ }
  async count() { /* ... */ }
}

DebugModule.forRoot({ storage: new FileStorage('./.nest-debug-panel') });
```

Methods may be sync or async. `list()` must return newest-first and should stay cheap — it backs the dashboard's 2-second polling.

## Custom frontends

The dashboard is one consumer of the JSON API; build your own (React, Vue, a CLI) against:

- `GET  {prefix}` with `Accept: application/json` → `RequestSummary[]`
- `GET  {prefix}/:id` with `Accept: application/json` → full `RequestProfile`
- `DELETE {prefix}` → clear

All types are exported from the package root.
