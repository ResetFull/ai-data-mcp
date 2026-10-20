# AI Data MCP

Local MySQL, Redis, and MongoDB tools for AI agents and developers.

[中文说明](README.zh-CN.md) · [Configuration](docs/configuration.md) · [Tool contracts](docs/tool-contracts.md) · [Security](SECURITY.md)

**Public Alpha:** single operator, local machine, read-only by default. Production
connections always reject writes. Non-production writes require explicit local
configuration opt-in. Eighteen provider-specific tools share STDIO and authenticated
loopback Streamable HTTP transports.

| Provider | Inspection and reads | Explicit non-production writes |
|---|---|---|
| MySQL | Connections, tables/views, columns/indexes, parameterized SQL | Single DML/DDL, managed DML transactions |
| Redis | Connections, SCAN, allowlisted read commands | Allowlisted mutations |
| MongoDB | Connections, collections, find/count/aggregate | Insert, filtered update/delete |

## Try without credentials

Requires Node.js 22.12+ (CI: Node 22/24). Python 3.10+ is needed for publication
checks and packaging. No model API key or database is needed for the demo.

```sh
git clone https://github.com/ResetFull/ai-data-mcp.git
cd ai-data-mcp
npm ci --ignore-scripts
npm run build
npm run demo
```

The demo starts a real STDIO MCP subprocess, discovers 18 tools, reads temporary
synthetic configuration, and verifies write guards before database access. It
opens no database sockets and does not read your existing configuration.

## Configure your databases

```sh
npm run config:init
# Edit ~/.config/data-mcp/connections.json and secrets.json outside the checkout.
npm run config:validate
npm run smoke:configured
```

Initialization preserves existing files. Validation and configured smoke check
configuration only; they do not establish connectivity or database permissions.
See [all fields and overrides](docs/configuration.md).

Each connection has an environment (prod/staging/test/dev/local) and write_enabled
(default false). Only a non-production connection with write_enabled=true can use
write tools. Use database-enforced read-only accounts for production.

Successful query results are returned to your chosen AI host and may reach its
model provider. Arbitrary query values are not automatically masked. Keep secrets
outside source control and use the minimum database grants needed.

## Connect any STDIO MCP client

Start the server directly, or configure your MCP host to launch it:

```sh
node dist/index.js --transport=stdio
```

```json
{
  "mcpServers": {
    "data-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/ai-data-mcp/dist/index.js", "--transport=stdio"]
    }
  }
}
```

Replace the path with your real absolute path; on Windows use forward slashes or
JSON-escaped backslashes. Logs go to stderr and protocol messages to stdout.
Restart the server process after configuration changes.

## Optional shared HTTP and Codex plugin

For a shared local process, set DATA_MCP_HTTP_TOKEN in both the server and client
environments and run npm run start:http. The service listens only on loopback;
/mcp requires the bearer token and /health is a local process-health endpoint.
See [HTTP setup](docs/configuration.md#optional-shared-http).

Windows users may run npm run service:install after building. This installs the
current-user AI-Data-MCP scheduled task and generates/reuses a user-scoped token.
Restart Codex to inherit it. The installer refuses ports owned by other processes.

After configuring and starting that HTTP service, install the optional adapter:

```sh
codex plugin marketplace add https://github.com/ResetFull/ai-data-mcp.git
codex plugin add data-mcp@ai-data-mcp
```

The plugin connects to 127.0.0.1:17890; installation alone does not build the server
or install a daemon. The generic STDIO configuration above works independently of
the marketplace. Existing personal plugins with the same data-mcp identity should
be managed explicitly in the host before switching installations.

Windows lifecycle commands: service:start, service:status, service:stop, and
service:uninstall (run through npm run). Removal preserves external configuration
and the shared token. Other operating systems can supervise the HTTP process
themselves; no systemd/launchd installer is shipped.

## Writes and failure recovery

MySQL DDL requires allow_ddl=true; UPDATE/DELETE without WHERE requires allow_all=true.
MongoDB update/delete with an empty filter also requires allow_all=true. These flags
do not bypass production or local write opt-in. DDL may implicitly commit, and
managed transaction atomicity requires transactional tables such as InnoDB.

An interrupted write may have committed. WRITE_OUTCOME_UNKNOWN requires read-back
before retrying; it is not evidence of rollback. The server does not automatically
retry writes or provide a persistent idempotency store. See [operation contracts](docs/tool-contracts.md).

Successful tool responses have a combined 100000-byte text/structured-data budget.
Output bounds do not certify SQL cost, database workload, or peak driver memory.
MySQL handshakes are bounded but active connections are not capped.

## Validate and package

```sh
npm run check
npm run smoke
npm audit
python -B scripts/privacy_check.py
python -B scripts/publication_checks.py
python -B scripts/package_release.py
```

Release packaging requires a clean committed checkout, rebuilds the runtime, scans
source and the final allowlisted ZIP, and writes SHA256SUMS. It includes source,
compiled runtime, examples, tests, and documentation; dependencies are not bundled.
GitHub Actions verifies Windows/Linux with Node 22/24 and disposable MySQL 8.4,
Redis 7.4, and MongoDB 7.0 services. [Validation scope and limitations](docs/validation.md)
separate these checks from business-system acceptance and unvalidated platforms.

## License and contributions

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party dependencies](docs/third-party.md),
[contribution guidance](CONTRIBUTING.md), and [security policy](SECURITY.md).
