# Changelog

## 0.1.0-alpha.1

First public Alpha, derived from a personal database MCP plugin.

- Eighteen MySQL, Redis, and MongoDB tools with STDIO and loopback HTTP transports.
- Per-connection write opt-in, mandatory production read-only enforcement,
  explicit MySQL DDL/unfiltered-write flags, and MongoDB empty-filter controls.
- Safe MySQL error mapping and structured errors without raw driver values.
- Shared response-byte budget, Redis deadline, MongoDB socket bounds,
  interrupted-write guidance, and disabled MongoDB automatic write retries.
- Credential-free protocol/policy demo, non-destructive config initialization,
  real HTTP security tests, and isolated three-provider integration checks.
- Updated dependency lockfile, CI, privacy gates, deterministic release archives,
  coherent plugin metadata, and English/Chinese installation documentation.

Compatibility: existing non-production connections become read-only until their
owner explicitly sets write_enabled=true. Restart the server after configuration
changes. The original personal plugin is not updated by publishing this repository.
