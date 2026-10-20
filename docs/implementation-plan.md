# Public Alpha implementation plan

Target: publish AI Data MCP at `ResetFull/ai-data-mcp` under Apache-2.0, retaining
the `data-mcp` plugin identity and the existing 18 provider-specific tools.
The original personal plugin and its external configuration remain separate.

## Delivery contract

- Local, single-operator STDIO is the portable entrypoint; authenticated loopback
  HTTP and the existing Windows scheduled task are optional.
- Every connection defaults to read-only. Production stays read-only even when
  write_enabled is true. Other environments require explicit per-connection opt-in.
- Raw database errors never enter public tool responses. Interrupted writes are
  reported as uncertain, with no automatic retry or claim of rollback.
- Query results are business data and can be sent to the model chosen by the host;
  the server does not promise automatic masking of arbitrary query results.
- Publication contains examples and synthetic fixtures only, with no live database
  access or maintainer credentials in tests, CI, source, or release packages.

## Implementation and verification

1. Import the bounded personal source into this independent repository.
   Verify: no node_modules, compiled output, or live configuration is copied.
2. Add failing regression cases for error redaction, write opt-in, response limits,
   and smoke failure detection; implement the smallest policy changes.
   Verify: existing lifecycle/policy tests and new boundary tests pass.
3. Add safe configuration initialization/validation, credential-free demonstration,
   portable client examples, coherent manifests, and install/removal documentation.
   Verify: temporary config creation preserves existing files; demo uses no network;
   STDIO discovery and harmless configured dispatch succeed.
4. Update vulnerable dependencies and establish Windows/Linux checks, real HTTP
   security tests, and isolated MySQL/Redis/MongoDB integration in GitHub Actions.
   Verify: clean dependency install, build, unit/security tests, audit, integration,
   privacy gate, and package checks succeed on the published commit.
5. Add deterministic release packaging, source/archive privacy checks, license,
   contribution/security guidance, version history, and validation evidence.
   Verify: unpacked release installs/builds/tests; manifest versions agree;
   repeated packaging yields identical checksums; every changed file is reviewed.
6. Publish the public GitHub repository and prerelease only after local gates pass.
   Verify: remote/local commit parity, successful CI, release assets and hashes,
   and no pending working-tree changes. Record unvalidated platforms explicitly.

No hosted multi-user service, OAuth gateway, automatic write retry, automatic
recovery, or additional data provider is part of this Alpha.
