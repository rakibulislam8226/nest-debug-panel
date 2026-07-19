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
