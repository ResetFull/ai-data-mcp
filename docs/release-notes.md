# 0.1.0-alpha.1

AI Data MCP is a local, single-operator database MCP server with 18 MySQL, Redis,
and MongoDB tools. This first public Alpha makes the personal plugin reproducible,
read-only by default, documented, tested, and independently installable.

Non-production writes now require write_enabled=true in local configuration.
Production remains read-only regardless of that flag. MySQL DDL and mutations
without WHERE require explicit per-call flags. Interrupted writes require read-back
before retrying. See SECURITY.md and docs/tool-contracts.md for exact boundaries.

The ZIP contains source, compiled runtime, tests, configuration templates, and
documentation. Install dependencies with npm ci --ignore-scripts, then use the
README quickstart. No npm registry publication is implied by this GitHub release.
Dependencies are not bundled. Verify SHA256SUMS before extracting the archive.

The portable MCP STDIO entrypoint runs directly from the checkout. The optional
Codex marketplace adapter connects to the separately configured local HTTP service;
plugin installation alone does not install Node dependencies or a daemon.

Validation scope and unvalidated platforms are recorded in docs/validation.md.
