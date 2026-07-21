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

### Added
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

[Unreleased]: https://github.com/rakibulislam8226/nest-debug-panel/compare/v0.1.7...HEAD
