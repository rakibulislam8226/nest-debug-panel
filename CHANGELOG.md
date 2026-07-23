# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Releases are published automatically to npm on merge to `master`. Versions up
> to and including **0.1.7** predate this changelog — see the
> [GitHub Releases](https://github.com/rakibulislam8226/nest-debug-panel/releases)
> and [npm versions](https://www.npmjs.com/package/nest-debug-panel?activeTab=versions)
> for their history.

## [Unreleased]

## [0.2.0] - 2026-07-23

### Added
- **Automatic background-job capture.** Background work is now captured like HTTP
  requests and socket events, with **zero extra setup** — `DebugModule.forRoot()`
  is all you need. Each run becomes its own profile with the SQL/Redis/HTTP it
  makes (N+1 detection, timeline and all), plus the queue, job name, id, attempt,
  payload (redacted) and return value, surfaced in a new **Jobs** monitor.
  Auto-detected across the DI container for **`@nestjs/bullmq`** (`@Processor` /
  `WorkerHost`), **`@nestjs/microservices`** consumers (`@MessagePattern` /
  `@EventPattern`), **`@nestjs/schedule`** (`@Cron`/`@Interval`/`@Timeout`), and
  DI-provided **bee-queue / Agenda** (best-effort). Turn it off with `jobs: false`,
  skip a processor with `@DebugIgnore()`, or drop payloads with
  `captureJobData: false`. For workers outside Nest's DI (or legacy `@nestjs/bull`)
  the exported `@TrackJob()` decorator and `trackJob()` helper capture a handler in
  one line. No new dependency is added.
- **SQL formatting in the dashboard.** Click a SQL row in the request **Timeline**
  to expand the full statement, pretty-printed. The **SQL** tab gains a
  Pretty / Compact / Raw format selector that reformats every captured query
  in place.
- **Broader npm keywords** so the package surfaces for more NestJS
  debugging/profiling/queue searches.
- **`NEST_DEBUG_PANEL_ENABLED` environment variable.** Toggle the panel on or off
  straight from the environment — no code change. When set to a recognized
  boolean (`true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`, case-insensitive) it
  **takes precedence** over both the `enabled` option and the `NODE_ENV` default,
  so you can force it on in any environment or disable it in development. Leaving
  it unset preserves the existing behavior exactly.
- **Redesigned dashboard.** The UI is now a Telescope-style single-page app: a
  fixed left sidebar of **monitors** (Overview, Requests, Sockets, Queries,
  Logs, Exceptions, Slow) with live counts, and an **Overview** landing page
  with KPI tiles (total requests, average latency, error rate, slow count, total
  SQL, N+1 alerts), a latency chart and a recent-activity feed. Adds a global
  **Queries** view (every SQL query across all requests, with N+1/duplicate
  flags), plus **Exceptions** and **Slow** views, a filter/search box, relative
  timestamps and a live-connection indicator. Fully responsive down to mobile,
  and auto-refresh only re-renders when new data is captured (no flicker).
- **Log capture.** `console.*` output emitted while a request or socket event is
  executing is attached to that request's profile and surfaced in the new
  **Logs** monitor (and a per-request Logs tab), with level, message and logger
  context. The console is patched at bootstrap and restored on shutdown;
  original output still prints. Turn it off with `captureLogs: false`.
- **Automatic socket.io event capture.** Inbound NestJS WebSocket handlers
  (`@SubscribeMessage`) are now captured like HTTP requests with **zero extra
  setup** — `DebugModule.forRoot()` is all you need, no per-gateway decorator.
  (NestJS does not apply global interceptors to gateways, so the panel attaches
  itself to every gateway at startup.) Each handler runs inside the same tracing
  context, so every SQL/Redis/HTTP call it makes is recorded automatically, with
  N+1 detection and a timeline, plus the event name, namespace, socket id, rooms,
  handshake (redacted), payload and acknowledgement. Socket events appear in the
  **same list** as HTTP requests with a `WS` badge and an All / HTTP / Socket
  filter. Turn it off with `sockets: false`. An optional `@TrackSocketEvents()`
  decorator is exported for edge cases the auto-attach can't reach. No new
  dependency is added, and HTTP capture is unchanged.
- **Prisma 7 zero-config raw SQL capture.** Auto-instrumentation now wraps the
  Prisma driver adapter (e.g. `@prisma/adapter-pg`) directly, so the actual SQL
  text, params and timing are captured without setting the `log` option. Each
  query is tagged with the ORM model/operation that produced it.
- Raw SQL events are tagged with their `model.operation` (Telescope/Silk-style)
  when the originating Prisma operation is known.
- Client-side pagination for the SQL panel in the request detail view, with a
  per-page selector.

### Changed
- Auto-instrumentation only warns that raw SQL is unavailable when neither a
  driver adapter nor query-event logging is present.

[Unreleased]: https://github.com/rakibulislam8226/nest-debug-panel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rakibulislam8226/nest-debug-panel/compare/v0.1.7...v0.2.0
