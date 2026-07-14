# nest-debug-panel

[![npm version](https://img.shields.io/npm/v/nest-debug-panel)](https://www.npmjs.com/package/nest-debug-panel)
[![license](https://img.shields.io/npm/l/nest-debug-panel)](LICENSE)
[![node](https://img.shields.io/node/v/nest-debug-panel)](package.json)

**The debug panel for NestJS** — a development-time request inspector and profiler. See everything that happens inside every HTTP request of your NestJS application: SQL queries, Redis commands, outgoing HTTP calls, exceptions, memory usage, and a full execution timeline — in a built-in dashboard at `/__debug`.

One module import. Zero changes to your business logic. Built the NestJS way: a global interceptor, `AsyncLocalStorage` request contexts, dependency injection, and a plugin architecture.

```
GET /users          32ms   200   5 SQL queries
GET /orders/42     181ms   200   1 SQL query · slow
GET /boom            8ms   500   exception
```

## Features

- **Zero changes to business logic** — one module import and everything is captured automatically
- **Request profiling** — method, URL, params, headers (redacted), body, user, IP, status, response body/size, duration
- **Database profiling** — database-agnostic, adapter-based: **Prisma, TypeORM, Sequelize, Mongoose, Knex/Objection, Drizzle** (any underlying DB — Postgres, MySQL, SQLite, Mongo, ...): raw SQL, params, duration, total SQL time, slowest query, duplicate queries, **N+1 detection**
- **Redis profiling** — every command with arguments and timing (ioredis & node-redis)
- **HTTP client profiling** — Axios, `fetch`, Nest `HttpService`
- **Exception tracking** — name, message, stack trace, status, time-to-failure
- **Memory profiling** — heap/RSS deltas per request, event-loop delay
- **Timeline** — chronological view of everything inside the request, plus custom marks
- **Built-in dashboard** — server-rendered, dark, no frontend build step; JSON API for tooling
- **Safe by default** — disabled in production, sensitive keys/headers redacted, optional `authorize` callback

## Installation

### 1. Install the package

```bash
npm install nest-debug-panel
# or
yarn add nest-debug-panel
# or
pnpm add nest-debug-panel
```add local test

Requires Node.js ≥ 18 and NestJS 9, 10, or 11. No other dependencies — ORM/Redis/HTTP adapters are optional and hook into libraries you already have.

### 2. Register the module

Add `DebugModule.forRoot()` to your root module (preferably **first** in the imports list, so its interceptor wraps everything):

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { DebugModule } from 'nest-debug-panel';

@Module({
  imports: [
    DebugModule.forRoot(), // enabled automatically when NODE_ENV !== 'production'
    // ...your other modules
  ],
})
export class AppModule {}
```

That's it — no changes to controllers, services, or business logic.

### 3. Open the dashboard

Start your app as usual and open:

```
http://localhost:<your-port>/__debug
```

### 4. Verify it works

Hit any endpoint of your API, then check the dashboard (it auto-refreshes every 2s), or verify from the terminal:

```bash
curl http://localhost:3000/api/anything            # any request to your app
curl http://localhost:3000/__debug -H 'accept: application/json'
# → [{ "method": "GET", "url": "/api/anything", "statusCode": 200, "durationMs": ... }]
```

If the list is empty, check that `NODE_ENV` is not `production` (or pass `enabled: true` explicitly) and that the route isn't in your `ignore` list.

### 5. Database / Redis / HTTP capture — automatic for most stacks

At bootstrap the panel scans your app's providers and **auto-instruments** anything it recognizes — no wiring needed:

| Detected provider | What you get automatically |
| --- | --- |
| `PrismaClient` (or a service extending it) | every operation (`User.findMany`, duration, counts, N+1 detection) |
| ioredis / node-redis client | every command with args + timing |
| TypeORM `DataSource` | every SQL statement with params + timing |
| `HttpService` / axios instance | every outgoing call with status + timing |

Disable with `autoInstrument: false`. Explicit plugin wiring (below) still works and takes precedence — use it for the pieces auto-detection can't reach:

- **Prisma raw SQL text**: Prisma only emits query events when the client is *constructed* with `log: [{ emit: 'event', level: 'query' }]` — add that one line to see actual SQL instead of `User.findMany`.
- **Mongoose / Drizzle / Knex**: their hooks are constructor-time options, so they need the 2-line explicit setup shown below.
- Clients created outside Nest's DI container.

## Configuration

All options with their defaults:

```ts
DebugModule.forRoot({
  enabled: process.env.NODE_ENV !== 'production',
  maxRequests: 200,             // ring buffer size; oldest profiles evicted
  captureRequestBody: true,
  captureResponseBody: true,
  captureHeaders: true,
  captureMemory: true,
  captureSql: true,
  captureRedis: true,
  captureHttp: true,
  slowQueryThreshold: 100,      // ms — queries at/above are flagged
  slowRequestThreshold: 500,    // ms — requests at/above are flagged
  nPlusOneThreshold: 5,         // repeated SELECTs to trigger the N+1 warning
  routePrefix: '/__debug',
  ignore: ['/health', '/docs*', /^\/webhooks\//],
  redactKeys: ['password', 'secret', 'token', ...],
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  maxBodyLength: 65536,         // bytes kept per captured body
  getUser: (req) => (req as any).user,       // how to extract the authenticated user
  authorize: (req) => true,     // gate the dashboard, e.g. admin-only
  storage: undefined,           // custom DebugStorage driver (default: in-memory)
  plugins: [],                  // profiling plugins, see below
});
```

`forRootAsync({ imports, useFactory, inject, routePrefix })` is also available — note `routePrefix` must be static because routes are registered before async factories run.

### Excluding routes

- **Options**: `ignore: ['/health', '/static/*', /^\/swagger/]`
- **Decorator**: `@DebugIgnore()` on any controller class or route handler
- The debug routes themselves are always excluded.

## Database profiling — works with any ORM / database

Nothing database-specific lives in the core. Adapters ship for every major ORM — and because they hook the ORM rather than the database driver, they work with whatever database sits underneath (PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, ...):

| ORM / query builder | Adapter | Raw SQL | Timing |
| --- | --- | --- | --- |
| Prisma | `PrismaPlugin` | ✅ | ✅ |
| TypeORM | `TypeOrmPlugin` | ✅ | ✅ |
| Sequelize | `SequelizePlugin` | ✅ | ✅ |
| Knex (+ Objection.js, Bookshelf) | `KnexPlugin` | ✅ | ✅ |
| Mongoose (MongoDB) | `MongoosePlugin` | operations + args | — |
| Drizzle | `DrizzlePlugin` | ✅ | — |
| anything else | implement `DebugPlugin` and call `recorder.recordSql(...)` from your ORM's query hook | | |

All adapters are fail-open (a broken hook never breaks a query), structurally typed (no dependency on any ORM package), and pass through untouched outside profiled requests.

### TypeORM

```ts
const typeormPlugin = new TypeOrmPlugin();
// DebugModule.forRoot({ plugins: [typeormPlugin] })
typeormPlugin.attach(dataSource); // after DataSource.initialize()
```

### Sequelize

```ts
const sequelizePlugin = new SequelizePlugin();
// DebugModule.forRoot({ plugins: [sequelizePlugin] })
sequelizePlugin.attach(sequelize); // your existing `logging` option keeps working
```

### Mongoose

```ts
const mongoosePlugin = new MongoosePlugin();
// DebugModule.forRoot({ plugins: [mongoosePlugin] })
mongoosePlugin.attach(mongoose); // the imported mongoose instance
```

### Knex / Objection.js / Bookshelf

```ts
const knexPlugin = new KnexPlugin();
// DebugModule.forRoot({ plugins: [knexPlugin] })
knexPlugin.attach(knex);
```

### Drizzle

```ts
const drizzlePlugin = new DrizzlePlugin();
// DebugModule.forRoot({ plugins: [drizzlePlugin] })
const db = drizzle(pool, { logger: drizzlePlugin.logger() });
```

### Prisma

The Prisma adapter:

```ts
// prisma.plugin.ts — create one shared instance
import { PrismaPlugin } from 'nest-debug-panel';
export const prismaPlugin = new PrismaPlugin();
```

```ts
// app.module.ts
DebugModule.forRoot({ plugins: [prismaPlugin] })
```

```ts
// prisma.service.ts
const client = new PrismaClient({
  log: [{ emit: 'event', level: 'query' }],   // enables raw SQL + params + duration
});
prismaPlugin.attach(client);                   // 1) raw query events
export const db = client.$extends(prismaPlugin.extension()); // 2) request attribution + timeline marks
```

Use `db` for your queries. You get raw SQL, parameters, per-query duration, total SQL time, the slowest query, duplicate-query groups, and N+1 warnings in the SQL tab.

Why both steps? Prisma emits raw `query` events from its engine **outside** the request's async context. The extension runs **inside** it and correlates the two. If you skip step 1, you still get ORM-level events (`User.findMany`, duration) from the extension alone.

Using an ORM not listed above? Implement `DebugPlugin` and call `recorder.recordSql(...)` from any query hook your ORM exposes — all types are exported from the package root.

## Redis profiling

```ts
import { RedisPlugin } from 'nest-debug-panel';
export const redisPlugin = new RedisPlugin();

// DebugModule.forRoot({ plugins: [redisPlugin] })
// wherever you create the client:
redisPlugin.attach(ioredisClient); // works for ioredis and node-redis v4+
```

Every command (`GET`, `SET`, `DEL`, `HSET`, …) is recorded with arguments (truncated), duration, and errors.

## HTTP client profiling

```ts
import { AxiosPlugin, FetchPlugin } from 'nest-debug-panel';

const axiosPlugin = new AxiosPlugin();
// DebugModule.forRoot({ plugins: [axiosPlugin, new FetchPlugin()] })

// Nest HttpService:
axiosPlugin.attach(this.httpService.axiosRef);
// Plain axios:
axiosPlugin.attach(axiosInstance);
// fetch: FetchPlugin patches globalThis.fetch (restored on shutdown)
```

Captured: URL, method, status, duration, request size, response size, errors.

## Custom timeline marks & data

Inject `DebugContextService` anywhere:

```ts
constructor(private readonly debug: DebugContextService) {}

async handle() {
  this.debug.mark('Cache warm-up', 4.2); // shows on the timeline
  this.debug.setCustom('tenantId', tenant.id); // stored on the profile
}
```

## Debug API

Content-negotiated — browsers get HTML, everything else JSON:

| Route | Method | Description |
| --- | --- | --- |
| `/__debug` | GET | Request list (JSON summaries or HTML dashboard) |
| `/__debug/:id` | GET | Full profile (JSON or HTML detail page with Timeline/SQL/Redis/HTTP/Exception/Memory/Headers/Body/Response tabs) |
| `/__debug` | DELETE | Clear history |

## Security

- **Disabled automatically in production** (`NODE_ENV === 'production'`) unless you explicitly set `enabled: true`. When disabled, the interceptor passes requests through untouched and the debug routes return 404.
- Sensitive body keys and headers are redacted before storage.
- Use `authorize` to gate the dashboard: `authorize: (req) => req.user?.isAdmin === true`.
- Profiles live in process memory by default and never leave the machine.

## Storage

The default is an in-memory ring buffer (`maxRequests`, oldest evicted). Provide any `DebugStorage` implementation for Redis/file/database persistence:

```ts
class RedisStorage implements DebugStorage {
  save(profile) { ... } find(id) { ... } list() { ... } clear() { ... } count() { ... }
}
DebugModule.forRoot({ storage: new RedisStorage(client) });
```

## Example app

```bash
npm run example
# open http://localhost:3000/__debug
```

Endpoints demonstrating each feature: `/users`, `/users/:id`, `POST /users` (redaction), `/n-plus-one` (N+1 warning), `/slow` (slow flags), `/external` (fetch capture), `/boom` (exception).

## Architecture

```
DebugModule.forRoot()
 ├─ DebugInterceptor (global)      creates a profile per request, runs the
 │                                 handler inside AsyncLocalStorage
 ├─ DebugContextService            the per-request context + recorder API
 ├─ PluginManager                  registers plugins, dispatches lifecycle hooks
 │   ├─ MemoryPlugin (built-in)
 │   ├─ PrismaPlugin / RedisPlugin / AxiosPlugin / FetchPlugin
 │   └─ your plugins (implements DebugPlugin)
 ├─ DebugStorage (MemoryStorage)   pluggable persistence, ring buffer
 └─ DebugController                JSON API + server-rendered dashboard
```

No global mutable state; every request gets an isolated context. **Express and Fastify are both supported and covered by the integration test suite** — the interceptor only relies on request fields common to both adapters, so no configuration differs between them.

## License

MIT
