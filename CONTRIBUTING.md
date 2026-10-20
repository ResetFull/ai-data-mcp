# Contributing

Use Node.js 22.12+ or Node.js 24 and Python 3.10+. Start with a focused issue and a
synthetic reproducer. Do not attach live configuration, SQL results, or credentials.

```sh
npm ci --ignore-scripts
npm run check
npm run smoke
npm audit
python -B scripts/privacy_check.py
python -B scripts/publication_checks.py
```

The build must run before tests that exercise the compiled CLI. CI repeats these
checks on Windows/Linux and Node 22/24, then exercises disposable MySQL, Redis,
and MongoDB services. See docs/validation.md for the boundary of each check.

Preserve provider-specific semantics and production guards. Changes to writes,
authentication, error mapping, lifecycle, or result bounds need failure/boundary
tests. Never disable validation, delete tests, or use maintainer databases to make
a check pass. Keep one purpose per change and explain non-obvious choices.

Use conventional commits and a focused PR describing behavior, validation, and
compatibility. Contributions must be yours to submit under Apache-2.0; preserve
third-party licenses and notices. Report vulnerabilities as described in SECURITY.md.
