# Contributing to nest-debug-panel

Thanks for taking the time to contribute! This is a small, focused project, so the process is light.

## Ways to help

- Report a bug or rough edge (open an issue).
- Suggest a feature or an adapter for another ORM/driver.
- Improve the docs.
- Send a pull request.

## Development setup

Requires **Node.js 18+** (CI runs on Node 20) and npm.

```bash
git clone https://github.com/rakibulislam8226/nest-debug-panel.git
cd nest-debug-panel
npm install
```

Common tasks:

```bash
npm test           # run the Jest suite
npm run test:cov   # tests with coverage
npm run build      # type-check + compile to dist/
npm run example    # run the example app (example/main.ts)
```

Before opening a PR, make sure `npm test` and `npm run build` both pass — CI runs exactly these.

## Pull requests

1. Fork the repo and create a branch off `master` (e.g. `fix/typeorm-params`).
2. Keep the change focused; one logical change per PR.
3. Add or update tests for anything you change in `src/`.
4. Run `npm test` and `npm run build` locally.
5. Open the PR against `master`. CI must be green before review.

The maintainer may retarget your PR onto the `pre-master` integration branch — that's normal.

## Style

- **TypeScript**, matching the existing code — no linter is configured, so mirror the surrounding style (naming, spacing, comment density).
- Adapters and instrumentation must be **fail-open**: never let the debug panel break the host app. Wrap risky hooks in `try/catch` and no-op on failure.
- Prefer small, well-named helpers over clever one-liners.

## Commit messages

- Write plain, imperative messages: `fix typeorm param serialization`, not `fix: ...`.
- **No** Conventional-Commit prefixes (`feat:`, `chore:`, …).
- **No** `Co-Authored-By` trailers.

## Reporting bugs

Open an issue with:

- what you did and what you expected,
- the ORM/driver and versions (`nest-debug-panel`, `@nestjs/*`, Node),
- a minimal reproduction if you can.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
