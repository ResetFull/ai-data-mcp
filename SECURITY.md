# Security policy

This is a local, single-operator Public Alpha. The configuration owner and the
machine running the process are trusted. It is not a multi-user authorization
service, a hosted database gateway, or a tenant isolation layer.

## Report privately

Use GitHub private vulnerability reporting when available. Otherwise request a
private contact without publishing exploit details, credentials, host addresses,
database output, or personal data in an issue. Include a synthetic reproducer,
affected version, runtime, and observable impact. No response-time SLA is promised.

## Enforced boundaries

- Production connections reject every write tool, even with write_enabled=true.
- All other connections default to read-only and require local configuration opt-in.
- MySQL parsing rejects multiple statements, unsafe reads, and session control.
  Missing WHERE requires allow_all; DDL requires allow_ddl. A WHERE clause is not
  proof of a narrow or safe mutation. MySQL DDL may implicitly commit.
- MongoDB aggregation recursively rejects $out/$merge. Empty update/delete filters
  require allow_all. Redis uses explicit command allowlists and blocks KEYS,
  scripts, administration, transactions, and arbitrary command execution.
- HTTP binds to loopback, validates Host/Origin, and requires a bearer token on
  /mcp. Health is unauthenticated and reveals process/version information locally.
  Every client holding that token has the same configured database access.
- Errors withhold raw driver messages. Successful tool responses have a combined
  100000-byte budget for text and structured data.

These are defense-in-depth controls, not substitutes for database grants. Use a
database-enforced read-only account for every production provider. Environment
labels are supplied by the configuration owner; the tool cannot discover whether
a mislabeled server is actually production. The SQL parser does not certify query
cost or every server extension. Use least-privilege accounts and indexed queries.

## Data and failure semantics

Query results are intentionally returned to the calling host. Arbitrary field
values are not automatically masked. The chosen AI host may send those results
to its model provider. This project contains no model backend or telemetry collector.

Never infer that an interrupted write failed or rolled back. WRITE_OUTCOME_UNKNOWN
requires read-back/reconciliation before another write. There is no automatic
write retry; MongoDB driver write retries are disabled. Managed MySQL transactions
attempt rollback after errors, but a disconnected COMMIT cannot establish outcome.
Atomicity requires transactional tables such as InnoDB.

Output limits constrain the returned payload, not database work or the driver's
peak memory use. MySQL only bounds concurrent handshakes, not active connections.
Redis commands have a 15-second client deadline. MongoDB reads have maxTimeMS,
with 15-second socket inactivity and bounded server selection; these are not a
single wall-clock deadline. MySQL timeout_ms applies per statement.

## Publication hygiene

Keep live configuration, secrets, tokens, receipts, logs, and dependency directories
outside source and release assets. Use temporary fixtures and disposable database
services in CI. Source and archive privacy scans are conservative best-effort
checks; they cannot identify every secret, private hostname, or sensitive value.
Review staged changes and the exact release archive before publication.
