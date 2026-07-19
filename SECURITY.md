# Security Policy

## Supported versions

This project follows the latest published release on npm. Security fixes are applied to the most recent version; please upgrade to the latest before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through either:

- **GitHub Security Advisories** — [open a private report](https://github.com/rakibulislam8226/nest-debug-panel/security/advisories/new) (preferred), or
- **Email** — rakibulislam8226@gmail.com

Please include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version(s) and environment.

You'll get an acknowledgement as soon as possible. Once a fix is ready, a patched version will be published to npm and the advisory disclosed.

## Scope note

`nest-debug-panel` is a **development** tool that exposes request data (bodies, headers, SQL, timings) on a dashboard route. It defaults to disabled in production (`NODE_ENV === 'production'`) and supports redaction and an `authorize` gate. Reports about the dashboard being reachable in production due to **misconfiguration** are best raised as regular issues; genuine vulnerabilities in the library's own access control, redaction, or fail-open behavior belong here.
