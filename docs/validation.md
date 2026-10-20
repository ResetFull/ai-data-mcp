# Validation

Each check establishes only the boundary described below. CI links and the final
GitHub commit identify the checked source; business databases are never involved.

| Check | Establishes |
|---|---|
| npm run check | Fresh TypeScript build; policy, lifecycle, safe errors, write opt-in, response bytes, config preservation, smoke failure detection, real HTTP security |
| npm run smoke / npm run demo | Real STDIO discovery of 18 tools, successful configuration dispatch, all-provider write guards with temporary fixtures; no database sockets |
| npm run smoke:configured | Local configuration can be read through STDIO; no database connection or write probe |
| npm audit | Current registry advisory results for the locked dependency tree; not proof of exploitability or complete security |
| npm run test:integration | All 18 tools against disposable MySQL/Redis/MongoDB, transaction rollback, read timeout recovery, actual MySQL readonly grants, output limits, write guards |
| privacy_check.py | Common private paths, key/token patterns, and non-example IPv4; best effort |
| publication_checks.py | Manifest alignment, readonly examples, privacy findings without secret values, archive traversal rejection |
| package_release.py | Fresh build, clean committed source, source/final archive privacy gates, file hashes, deterministic ZIP |

GitHub Actions checks Windows/Linux with Node 22 and 24. The integration job uses
MySQL 8.4, Redis 7.4, and MongoDB 7.0 service containers on Linux, loopback ports,
and public synthetic fixtures. It cannot read the maintainer's local configuration.
The test deliberately attempts writes only against those disposable services.

To run integration yourself, provision the same disposable services and set
DATA_MCP_INTEGRATION=1. Ports may be overridden by DATA_MCP_TEST_MYSQL_PORT,
DATA_MCP_TEST_REDIS_PORT, and DATA_MCP_TEST_MONGO_PORT. Hostnames are fixed to
127.0.0.1; the synthetic MySQL root password/database are defined in the CI file.
Do not point these ports at business services. Integration is intentionally not
part of the ordinary no-credentials demo.

Not certified by these checks: business end-to-end workflows, every SQL dialect
or server extension, MySQL 5.7, Redis Cluster/Sentinel, MongoDB replica-set failover,
macOS execution, custom TLS authorities, production grants, or model behavior.
The Windows scheduled-task lifecycle requires local interactive Windows facilities;
CI does not install a persistent task on the runner.
