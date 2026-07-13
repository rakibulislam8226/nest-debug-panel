# API reference

Everything below is exported from `@nest-lens/core`.

## Module

### `DebugModule.forRoot(options?: DebugModuleOptions): DynamicModule`

Registers (globally): the `DebugInterceptor` (via `APP_INTERCEPTOR`), `DebugContextService`, `PluginManager`, the storage driver, and the debug controller. See [README → Configuration](../README.md#configuration) for every option.

### `DebugModule.forRootAsync(options: DebugModuleAsyncOptions): DynamicModule`

```ts
DebugModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    enabled: config.get('DEBUG_ENABLED') === 'true',
    maxRequests: 500,
  }),
  routePrefix: '/__debug', // must be static in async mode
});
```

## Services

### `DebugContextService` (implements `DebugRecorder`)

Injectable anywhere (the module is global). Methods:

| Method | Description |
| --- | --- |
| `isActive()` | `true` inside a profiled request |
| `getProfile()` | the live `RequestProfile` or `undefined` |
| `run(profile, fn)` | run `fn` with `profile` as the active context (used by the interceptor) |
| `recordSql(event, target?)` | record a DB query (`SqlEventInput`) |
| `recordRedis(event, target?)` | record a Redis command (`RedisEventInput`) |
| `recordHttp(event, target?)` | record an outgoing HTTP call (`HttpEventInput`) |
| `recordException(error, target?)` | record an exception (name/message/stack/status) |
| `mark(label, durationMs?)` | append a custom timeline entry |
| `setCustom(key, value)` | attach free-form data to `profile.custom` |

All `record*` methods no-op outside a request context and respect the corresponding `capture*` flag. `target` overrides context resolution for adapters that lose the async context.

### `PluginManager`

Registers built-in + configured plugins on `onModuleInit`, dispatches `onRequestStart`/`onRequestEnd`, calls `onShutdown` on app shutdown. `getPlugins()` returns the active set.

## Interfaces

### `RequestProfile`

The full capture for one request:

```ts
{
  id, method, url, route?, queryParams, routeParams,
  headers?, body?, user?, ip?,
  startedAt (ISO), startedAtMs, endedAtMs?, durationMs?, slow?,
  statusCode?, responseBody?, responseSize?,
  sql: SqlQueryEvent[], redis: RedisCommandEvent[], http: HttpClientEvent[],
  timeline: TimelineEvent[],        // { at, label, kind, durationMs? }
  exception?: ExceptionInfo,        // { name, message, stack?, statusCode?, at }
  memory?: MemoryProfile,           // { before?, after?, heapUsedDelta?, eventLoopDelayMs? }
  sqlAnalysis?: SqlAnalysis,        // totals, slowest, duplicates, possibleNPlusOne
  custom: Record<string, unknown>,
}
```

`RequestSummary` is the lightweight list row (`toRequestSummary(profile)` converts).

### `DebugPlugin` / `DebugPluginContext`

See the [plugin guide](plugins.md).

### `DebugStorage`

`save`, `find`, `list` (newest first), `clear`, `count` — sync or async. `MemoryStorage` (ring buffer) is the default implementation.

## Plugins & adapters

| Export | Purpose |
| --- | --- |
| `PrismaPlugin` | `attach(client)` for raw `query` log events + `extension()` for request attribution |
| `RedisPlugin` / `instrumentRedisClient(client, recorder)` | times every command via a `sendCommand` wrapper (ioredis, node-redis) |
| `AxiosPlugin` / `instrumentAxios(instance, recorder)` | request/response interceptors on any axios instance (`httpService.axiosRef`) |
| `FetchPlugin` | patches `globalThis.fetch`; restored on shutdown |
| `MemoryPlugin` | built-in, auto-registered when `captureMemory` is on |

## Analysis

### `analyzeSql(queries, { slowQueryThreshold, nPlusOneThreshold }): SqlAnalysis`

Runs automatically per request. `normalizeSql(query)` strips literals/placeholders so query *shapes* group together; groups with `count >= 2` become `duplicates`, and read-query groups with `count >= nPlusOneThreshold` become `possibleNPlusOne`.

## Decorators

### `@DebugIgnore()`

Class or method decorator — excludes the controller/route from profiling.

## Guards

### `DebugAccessGuard`

Applied to the debug controller. Returns 404 when profiling is disabled; enforces the `authorize` callback otherwise.

## HTTP API

| Route | Method | Accept | Returns |
| --- | --- | --- | --- |
| `{prefix}` | GET | `application/json` | `RequestSummary[]` (newest first) |
| `{prefix}` | GET | `text/html` | dashboard |
| `{prefix}/:id` | GET | `application/json` | `RequestProfile` (404 if unknown) |
| `{prefix}/:id` | GET | `text/html` | detail page |
| `{prefix}` | DELETE | — | `{ cleared: true }` |

## Known limitations

- Guards execute **before** interceptors in Nest's pipeline, so exceptions thrown *by guards* (e.g. failed auth) are not captured as profiles. Everything from pipes onward is.
- Prisma raw-SQL ↔ request correlation is best-effort under heavy concurrency (see the correlator's doc comment); worst case a query event lands on a neighboring concurrent request.
- Event-loop delay is process-wide, not per-request.
- `MemoryStorage` is per-process; use a shared storage driver if you run multiple instances.
