<div align="center">

# nest-debug-panel

**A debug panel for NestJS.** See everything that happens inside every request.

[![npm version](https://img.shields.io/npm/v/nest-debug-panel)](https://www.npmjs.com/package/nest-debug-panel)
[![license](https://img.shields.io/npm/l/nest-debug-panel)](LICENSE)
[![node](https://img.shields.io/node/v/nest-debug-panel)](package.json)

</div>

---

You hit an endpoint and it takes 800ms. Was it the database? A cache miss? That one external API call? Instead of sprinkling `console.log` everywhere, open `/__debug` and look:

```
GET  /users          32ms   200   5 SQL queries
GET  /orders/42     181ms   200   1 SQL query · slow
GET  /boom            8ms   500   exception
```

Click any request and you get the full story: every SQL query with timing, Redis commands, outgoing HTTP calls, the exception with its stack trace, memory usage, and a timeline of the whole request from start to finish.

One module import. No changes to your business logic. Disabled in production by default.

## Quick start

Install it:

```bash
npm install nest-debug-panel
```

Register it in your root module, ideally first in the list so its interceptor wraps everything:

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { DebugModule } from 'nest-debug-panel';

@Module({
  imports: [
    DebugModule.forRoot(), // on when NODE_ENV !== 'production'
    // ...your other modules
  ],
})
export class AppModule {}
```

Start your app and open:

```
http://localhost:<your-port>/__debug
```

That's it. Hit any endpoint of your API and watch it appear in the dashboard (it refreshes every 2 seconds). If the list stays empty, make sure `NODE_ENV` isn't `production`, or pass `enabled: true` explicitly.

Works with Node.js 18+, NestJS 9/10/11, and both Express and Fastify. No runtime dependencies.

## What gets captured

For every request: method, URL, query and route params, headers (sensitive ones redacted), body, the authenticated user, IP, response status, response body and size, and total duration.

On top of that:

- **Database queries** with SQL text, parameters, and per-query timing, plus total SQL time, the slowest query, duplicate-query groups, and **N+1 detection**
- **Redis commands** with arguments and timing (ioredis and node-redis)
- **Outgoing HTTP calls** through Axios, `fetch`, or Nest's `HttpService`
- **Exceptions** with name, message, stack trace, and how long the request ran before failing
- **Memory**: heap and RSS deltas per request, event-loop delay
- **A timeline** that lays all of the above in order, plus your own custom marks

## Database, Redis and HTTP capture is automatic

At startup the panel scans your app's providers and instruments what it recognizes. In most projects you install the package and queries just show up:

| It finds | You get |
| --- | --- |
| `PrismaClient` (or a service extending it) | every operation with timing, counts, N+1 detection |
| ioredis / node-redis client | every command with args and timing |
| TypeORM `DataSource` | every SQL statement with params and timing |
| `HttpService` / axios instance | every outgoing call with status and timing |

You can turn this off with `autoInstrument: false`. A few things still need one line of manual setup, simply because they're constructor options in the library itself:

- **Prisma raw SQL text.** On **Prisma 7+ with a driver adapter** (e.g. `@prisma/adapter-pg`) auto-instrumentation captures raw SQL with **zero config** — it wraps the adapter directly, so you get the actual query text, params and timing without touching how the client is created. Each row is tagged with the ORM model and operation that produced it, so you see the SQL *and* its `User.findMany` context together (like Laravel Telescope / Django Silk). On older Prisma (no driver adapter) raw SQL still comes from query events, which require the client be created with `log: [{ emit: 'event', level: 'query' }]`; without either, you'll see `User.findMany (12ms)` instead of the SQL, and a one-time hint tells you how to enable it.
- **Mongoose, Drizzle and Knex** hook in at construction time, so wire them explicitly (two lines each, shown below).
- Clients created outside Nest's DI container.

## Configuration

Everything is optional. These are the defaults:

```ts
DebugModule.forRoot({
  enabled: process.env.NODE_ENV !== 'production',
  maxRequests: 200,             // how many profiles to keep; oldest are evicted
  captureRequestBody: true,
  captureResponseBody: true,
  captureHeaders: true,
  captureMemory: true,
  captureSql: true,
  captureRedis: true,
  captureHttp: true,
  autoInstrument: true,         // scan providers and hook them automatically
  slowQueryThreshold: 100,      // ms; queries at or above get flagged
  slowRequestThreshold: 500,    // ms; requests at or above get flagged
  nPlusOneThreshold: 5,         // repeated SELECTs before the N+1 warning fires
  routePrefix: '/__debug',
  ignore: ['/health', '/docs*', /^\/webhooks\//],
  redactKeys: ['password', 'secret', 'token', ...],
  redactHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
  maxBodyLength: 65536,         // bytes kept per captured body
  getUser: (req) => (req as any).user,
  authorize: (req) => true,     // gate the dashboard, e.g. admins only
  storage: undefined,           // custom storage driver; default is in-memory
  plugins: [],
});
```

`forRootAsync({ imports, useFactory, inject, routePrefix })` works too. Note that `routePrefix` must be static in async mode, because routes are registered before async factories run.

To exclude routes from profiling, use the `ignore` option (`'/health'`, globs like `'/static/*'`, or RegExps) or put `@DebugIgnore()` on a controller or handler. The panel's own routes are always excluded.

## Works with any ORM, any database

Nothing database-specific lives in the core. Adapters hook the ORM rather than the database driver, so the database underneath doesn't matter: PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, anything.

| ORM / query builder | Adapter | Raw SQL | Timing |
| --- | --- | --- | --- |
| Prisma | `PrismaPlugin` | ✅ | ✅ |
| TypeORM | `TypeOrmPlugin` | ✅ | ✅ |
| Sequelize | `SequelizePlugin` | ✅ | ✅ |
| Knex (and Objection.js, Bookshelf) | `KnexPlugin` | ✅ | ✅ |
| Mongoose | `MongoosePlugin` | operations + args | — |
| Drizzle | `DrizzlePlugin` | ✅ | — |

Every adapter is fail-open (a broken hook never breaks a query), has zero dependency on the ORM package itself, and costs nothing outside profiled requests.

### Prisma

```ts
// debug.plugins.ts — one shared instance
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
  log: [{ emit: 'event', level: 'query' }],   // raw SQL + params + duration
});
prismaPlugin.attach(client);
export const db = client.$extends(prismaPlugin.extension());
```

Why two steps? Prisma emits raw query events from its engine, outside the request's async context. The extension runs inside it and ties the two together. Skip step one and you still get operation-level events from the extension alone.

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

Using something else? Implement the `DebugPlugin` interface and call `recorder.recordSql(...)` from whatever query hook your ORM exposes. All types are exported from the package root.

## Redis

```ts
import { RedisPlugin } from 'nest-debug-panel';
export const redisPlugin = new RedisPlugin();

// DebugModule.forRoot({ plugins: [redisPlugin] })
redisPlugin.attach(ioredisClient); // ioredis and node-redis v4+
```

Every command (`GET`, `SET`, `DEL`, `HSET`, ...) is recorded with its arguments, duration, and any error.

## HTTP clients

```ts
import { AxiosPlugin, FetchPlugin } from 'nest-debug-panel';

const axiosPlugin = new AxiosPlugin();
// DebugModule.forRoot({ plugins: [axiosPlugin, new FetchPlugin()] })

axiosPlugin.attach(this.httpService.axiosRef); // Nest HttpService
axiosPlugin.attach(axiosInstance);             // or any axios instance
// FetchPlugin patches globalThis.fetch and restores it on shutdown
```

Captured: URL, method, status, duration, request size, response size, errors.

## Custom timeline marks

Inject `DebugContextService` anywhere and annotate the timeline yourself:

```ts
constructor(private readonly debug: DebugContextService) {}

async handle() {
  this.debug.mark('Cache warm-up', 4.2);        // shows on the timeline
  this.debug.setCustom('tenantId', tenant.id);  // stored on the profile
}
```

## The API behind the dashboard

The dashboard is plain HTML served by the package, but the same routes speak JSON. Browsers get HTML, everything else gets JSON:

| Route | Method | Returns |
| --- | --- | --- |
| `/__debug` | GET | request list |
| `/__debug/:id` | GET | full profile with timeline, SQL, Redis, HTTP, exception, memory, headers, body, response |
| `/__debug` | DELETE | clears history |

Build your own frontend or tooling on top of it if you like.

## Security

- Off in production automatically, unless you explicitly set `enabled: true`. When off, the interceptor passes requests straight through and the debug routes return 404.
- Sensitive body keys and headers are redacted before anything is stored.
- Gate the dashboard with `authorize: (req) => req.user?.isAdmin === true`.
- Profiles live in process memory by default and never leave your machine.

## Storage

The default store is an in-memory ring buffer that keeps the latest `maxRequests` profiles. Need persistence or sharing across instances? Implement the five-method `DebugStorage` interface and pass it in:

```ts
class RedisStorage implements DebugStorage {
  save(profile) { ... } find(id) { ... } list() { ... } clear() { ... } count() { ... }
}
DebugModule.forRoot({ storage: new RedisStorage(client) });
```

## Example app

The repo ships a small demo with an endpoint for every feature:

```bash
npm run example
# open http://localhost:3000/__debug
```

Try `/users`, `POST /users` (redaction), `/n-plus-one` (N+1 warning), `/slow` (slow flags), `/external` (fetch capture), and `/boom` (exception).

## How it works

```
DebugModule.forRoot()
 ├─ DebugInterceptor (global)      builds a profile per request, runs the
 │                                 handler inside AsyncLocalStorage
 ├─ DebugContextService            per-request context + recorder API
 ├─ AutoInstrumentService          scans providers, hooks what it recognizes
 ├─ PluginManager                  registers plugins, dispatches lifecycle hooks
 ├─ DebugStorage                   pluggable persistence (ring buffer default)
 └─ DebugController                JSON API + server-rendered dashboard
```

No global mutable state; every request gets an isolated context. Express and Fastify are both covered by the integration test suite. And everything is fail-open: if anything inside the panel ever breaks, profiling is skipped for that request and your app keeps running as if the package wasn't there.

## License

MIT © [Rakibul Islam](https://github.com/rakibulislam8226)
