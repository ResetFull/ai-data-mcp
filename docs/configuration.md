# Configuration

Build first, then run npm run config:init. It creates only missing files, using
exclusive creation and restrictive POSIX file modes. It never overwrites files.
Default paths on every platform are:

- ~/.config/data-mcp/connections.json
- ~/.config/data-mcp/secrets.json

DATA_MCP_CONFIG and DATA_MCP_SECRETS_FILE override these paths independently.
DATA_MCP_SECRETS_JSON, when nonempty, takes precedence over the secrets file and
uses the same provider-namespaced JSON shape. No automatic dotenv loading occurs.

Examples live in config/*.example.json. Edit copies outside the repository.
Then run npm run config:validate. Validation checks structure and secret references;
it does not connect to databases or verify grants. Restart the Data MCP process
after changes because configuration is cached for its lifetime.

## Common connection fields

| Field | Meaning |
|---|---|
| id | Unique within its provider; lower-case kebab-case, at most 64 characters |
| environment | prod, staging, test, dev, or local; unknown values are rejected |
| write_enabled | Defaults false; true permits writes only outside prod |
| connectTimeoutMs | Connection/server-selection timeout; defaults 10000 |

At least one provider must be present; each configured provider has 1–50 connections.
IDs may be reused across different providers. Public connection lists omit secrets
but include operational metadata such as host, database, username, and access_mode.

MySQL adds host, port (3306), database, user, and ssl (false). ssl=true requires
certificate verification. Private CA/custom TLS options are not supported by this
Alpha. The legacy connectionLimit field is accepted but does not cap connections.

Redis adds host, port (6379), database (0–15), optional username, and tls (false).
Password-only authentication is supported. Redis Cluster, Sentinel, custom CA
configuration, and unbounded commands are outside the validated contract.

MongoDB adds database and maxPoolSize (default 5). The URI belongs only in secrets,
under mongo.CONNECTION_ID.uri. URI options configure TLS/authentication. Automatic
write retries are disabled regardless of URI settings.

## Least-privilege accounts

Production labels do not replace server-side permissions. For MySQL, grant only
SELECT and SHOW VIEW on the required schema; omit administrative and FILE grants.
For Redis, create a dedicated ACL user with only required read commands and key
patterns. For MongoDB, assign the read role on only the required database. Verify
each account directly before connecting it to an AI host.

On POSIX, keep the directory mode at 700 and secrets at 600. On Windows, restrict
the secret file ACL to the intended user; POSIX mode bits alone do not set Windows
ACLs. Never put real credentials in client configuration committed to a repository.

## Optional shared HTTP

The default address is 127.0.0.1:17890. DATA_MCP_HTTP_HOST accepts only 127.0.0.1
or ::1; DATA_MCP_HTTP_PORT accepts 1–65535. DATA_MCP_HTTP_TOKEN is required.
Set the token in the server and client process environments; do not put it in a URL.

```sh
node dist/index.js --transport=http
```

On Windows, npm run service:install creates the current-user AI-Data-MCP scheduled
task and generates/reuses a user-scoped token. Restart the AI host to inherit that
environment variable. The installer refuses a port owned by another process.
service:start, service:status, service:stop and service:uninstall manage this task.
Removal preserves external configuration and the token, which may be shared by
other local installations. Stopping the service interrupts active work; reconcile
any in-flight write before retrying.

Linux/macOS users can run the HTTP process in their own supervisor. No systemd or
launchd installer is shipped or validated. STDIO requires no HTTP token.
