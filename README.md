# nest-lens

**Django Silk for NestJS.** A development-time request inspector that captures everything that happens inside every HTTP request — SQL queries, Redis commands, outgoing HTTP calls, exceptions, memory usage, and a full timeline — and shows it in a built-in dashboard.

Inspired by [Django Silk](https://github.com/jazzband/django-silk), [Django Debug Toolbar](https://github.com/jazzband/django-debug-toolbar), and [Laravel Telescope](https://laravel.com/docs/telescope), built with NestJS idioms: a global interceptor, `AsyncLocalStorage` request contexts, dependency injection, and a plugin architecture.

```
GET /users          32ms   200   5 SQL queries
GET /orders/42     181ms   200   1 SQL query · slow
GET /boom            8ms   500   exception
```

## Features

- **Zero changes to business logic** — one module import and everything is captured automatically
- **Request profiling** — method, URL, params, headers (redacted), body, user, IP, status, response body/size, duration
- **Database profiling** — adapter-based (Prisma first-class): raw SQL, params, duration, total SQL time, slowest query, duplicate queries, **N+1 detection**
- **Redis profiling** — every command with arguments and timing (ioredis & node-redis)
- **HTTP client profiling** — Axios, `fetch`, Nest `HttpService`
- **Exception tracking** — name, message, stack trace, status, time-to-failure
- **Memory profiling** — heap/RSS deltas per request, event-loop delay
- **Timeline** — chronological view of everything inside the request, plus custom marks
- **Built-in dashboard** — server-rendered, dark, no frontend build step; JSON API for tooling
- **Safe by default** — disabled in production, sensitive keys/headers redacted, optional `authorize` callback

## Install

```bash
npm install @nest-lens/core
```

## Quick start

```ts
import { Module } from '@nestjs/common';
import { DebugModule } from '@nest-lens/core';

@Module({
  imports: [
    DebugModule.forRoot({
      enabled: process.env.NODE_ENV !== 'production', // this is the default
    }),
  ],
})
export class AppModule {}
```

Open **`http://localhost:3000/__debug`** — every request is now captured.

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

## Database profiling (Prisma)

Nothing database-specific lives in the core — adapters plug in. The Prisma adapter:

```ts
// prisma.plugin.ts — create one shared instance
import { PrismaPlugin } from '@nest-lens/core';
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

Why both steps? Prisma emits raw `query` events from its engine **outside** the request's async context. The extension runs **inside** it and correlates the two (see `docs/plugins.md` for details). If you skip step 1, you still get ORM-level events (`User.findMany`, duration) from the extension alone.

Adapters for TypeORM/Drizzle/Sequelize/Mongoose follow the same pattern: implement `DebugPlugin` and call `recorder.recordSql(...)` — see the extension guide.

## Redis profiling

```ts
import { RedisPlugin } from '@nest-lens/core';
export const redisPlugin = new RedisPlugin();

// DebugModule.forRoot({ plugins: [redisPlugin] })
// wherever you create the client:
redisPlugin.attach(ioredisClient); // works for ioredis and node-redis v4+
```

Every command (`GET`, `SET`, `DEL`, `HSET`, …) is recorded with arguments (truncated), duration, and errors.

## HTTP client profiling

```ts
import { AxiosPlugin, FetchPlugin } from '@nest-lens/core';

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

## Documentation

- [API reference](docs/api-reference.md)
- [Plugin development & extension guide](docs/plugins.md)

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

No global mutable state; every request gets an isolated context. Express and Fastify are both supported (the interceptor only relies on common request fields).

## License

MIT
