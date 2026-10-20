import assert from "node:assert/strict";
import { temporaryConfiguration } from "./fixtures.mjs";
import { connectStdio, requireSuccess } from "./mcp-client.mjs";

const expectedTools = [
  "mysql_list_connections", "mysql_list_tables", "mysql_describe_table", "mysql_query", "mysql_execute", "mysql_execute_transaction",
  "redis_list_connections", "redis_scan_keys", "redis_command", "redis_execute",
  "mongo_list_connections", "mongo_list_collections", "mongo_find", "mongo_count_documents", "mongo_aggregate",
  "mongo_insert_one", "mongo_update_many", "mongo_delete_many",
];

async function main() {
  const configured = process.argv.includes("--configured");
  const fixture = configured ? undefined : await temporaryConfiguration();
  let client;
  try {
    client = await connectStdio(fixture?.environment);
    const discovery = await client.rpc("tools/list", {});
    assert.deepEqual(discovery.tools.map(tool => tool.name).sort(), [...expectedTools].sort());
    for (const provider of ["mysql", "redis", "mongo"]) {
      const listed = requireSuccess(await client.call(`${provider}_list_connections`, { response_format: "json" }), `${provider} configuration`);
      assert.ok(Array.isArray(listed.connections));
      if (!configured) {
        assert.equal(listed.connections.find(item => item.id === "local-disabled").access_mode, "read-only");
        assert.equal(listed.connections.find(item => item.id === "prod-readonly").access_mode, "read-only");
        assert.equal(listed.connections.find(item => item.id === "test-enabled").access_mode, "read-write");
      }
    }
    if (!configured) {
      const writes = [
        ["mysql_execute", { sql: "INSERT INTO demo_records(id) VALUES (?)", parameters: [1] }],
        ["redis_execute", { arguments: ["SET", "demo", "value"] }],
        ["mongo_insert_one", { collection: "demo_records", document: { id: 1 } }],
      ];
      for (const [name, args] of writes) {
        for (const id of ["local-disabled", "prod-readonly"]) {
          const result = await client.call(name, { ...args, connection_id: id });
          assert.equal(result.isError, true);
          assert.match(result.structuredContent.error.code, id === "local-disabled" ? /^WRITE_DISABLED$/ : /^PRODUCTION_/);
        }
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, tools: 18, mode: configured ? "configuration-only" : "isolated-demo", database_connections_opened: 0 }) + "\n");
  } finally {
    await client?.close();
    await fixture?.close();
  }
}

main().catch(error => {
  process.stderr.write(`Verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
