import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import { createClient } from "redis";
import { MongoClient } from "mongodb";
import { temporaryConfiguration } from "./fixtures.mjs";
import { connectStdio, requireSuccess } from "./mcp-client.mjs";

async function main() {
  if (process.env.DATA_MCP_INTEGRATION !== "1") {
    throw new Error("Run only against disposable CI services with DATA_MCP_INTEGRATION=1.");
  }
  const fixture = await temporaryConfiguration();
  const mysqlPort = Number(process.env.DATA_MCP_TEST_MYSQL_PORT ?? 3306);
  const redisPort = Number(process.env.DATA_MCP_TEST_REDIS_PORT ?? 6379);
  const mongoPort = Number(process.env.DATA_MCP_TEST_MONGO_PORT ?? 27017);
  const password = "synthetic-integration-password";
  let sql;
  let cache;
  let documents;
  let client;
  let assertions = 0;
  try {
    sql = await createConnection({ host: "127.0.0.1", port: mysqlPort, user: "root", password, database: "demo" });
    cache = createClient({ socket: { host: "127.0.0.1", port: redisPort, reconnectStrategy: false } });
    cache.on("error", () => {});
    await cache.connect();
    documents = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/demo`, { serverSelectionTimeoutMS: 5000, retryWrites: false });
    await documents.connect();
    await sql.query("CREATE USER IF NOT EXISTS 'demo_ro'@'%' IDENTIFIED BY 'synthetic-readonly-password'");
    await sql.query("GRANT SELECT, SHOW VIEW ON demo.* TO 'demo_ro'@'%'");

    for (const item of fixture.configuration.mysql.connections) {
      Object.assign(item, { port: mysqlPort, user: item.environment === "prod" ? "demo_ro" : "root" });
    }
    for (const item of fixture.configuration.redis.connections) item.port = redisPort;
    const secrets = {
      mysql: Object.fromEntries(fixture.configuration.mysql.connections.map(item => [item.id, {
        password: item.environment === "prod" ? "synthetic-readonly-password" : password,
      }])),
      mongo: Object.fromEntries(fixture.configuration.mongo.connections.map(item => [item.id, {
        uri: `mongodb://127.0.0.1:${mongoPort}/demo`,
      }])),
    };
    await writeFile(fixture.environment.DATA_MCP_CONFIG, JSON.stringify(fixture.configuration), { mode: 0o600 });
    await writeFile(fixture.environment.DATA_MCP_SECRETS_FILE, JSON.stringify(secrets), { mode: 0o600 });
    client = await connectStdio(fixture.environment);

    async function call(name, args = {}) {
      const result = await client.call(name, { connection_id: "test-enabled", response_format: "json", ...args });
      assertions++;
      return requireSuccess(result, name);
    }
    async function blocked(name, args, code) {
      const result = await client.call(name, { connection_id: "test-enabled", ...args });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, code);
      assertions++;
    }

    for (const provider of ["mysql", "redis", "mongo"]) {
      const result = requireSuccess(await client.call(`${provider}_list_connections`, { response_format: "json" }), provider);
      assert.equal(result.connections.length, 3);
      assertions++;
    }
    await blocked("mysql_execute", { sql: "DROP TABLE demo_records" }, "DDL_OPT_IN_REQUIRED");
    await call("mysql_execute", { sql: "CREATE TABLE demo_records(id INT PRIMARY KEY, label VARCHAR(100)) ENGINE=InnoDB", allow_ddl: true });
    await call("mysql_execute", { sql: "INSERT INTO demo_records(id, label) VALUES (?, ?)", parameters: [1, "synthetic-record"] });
    const query = await call("mysql_query", { sql: "SELECT id, label FROM demo_records WHERE id = ?", parameters: [1] });
    assert.deepEqual(query.rows, [{ id: 1, label: "synthetic-record" }]);
    await call("mysql_list_tables");
    await call("mysql_describe_table", { table: "demo_records" });
    await call("mysql_execute_transaction", { statements: [
      { sql: "INSERT INTO demo_records(id, label) VALUES (?, ?)", parameters: [2, "second"] },
      { sql: "INSERT INTO demo_records(id, label) VALUES (?, ?)", parameters: [3, "third"] },
    ] });
    await blocked("mysql_execute_transaction", { statements: [
      { sql: "INSERT INTO demo_records(id, label) VALUES (?, ?)", parameters: [20, "rollback"] },
      { sql: "INSERT INTO demo_records(id, label) VALUES (?, ?)", parameters: [1, "duplicate"] },
    ] }, "DUPLICATE_ENTRY");
    const rollback = await call("mysql_query", { sql: "SELECT COUNT(*) AS total FROM demo_records WHERE id = ?", parameters: [20] });
    assert.equal(Number(rollback.rows[0].total), 0);
    await blocked("mysql_execute", { sql: "DELETE FROM demo_records" }, "UNFILTERED_WRITE_BLOCKED");
    await blocked("mysql_query", { sql: "SELECT id FROM demo_records FOR UPDATE" }, "UNSAFE_READ_REJECTED");
    await sql.query("LOCK TABLES demo_records WRITE");
    try {
      await blocked("mysql_query", { sql: "SELECT id FROM demo_records", timeout_ms: 1000 }, "QUERY_TIMEOUT");
    } finally {
      await sql.query("UNLOCK TABLES");
    }
    assert.equal((await call("mysql_query", { sql: "SELECT 1 AS recovered" })).rows[0].recovered, 1);
    const readonly = await createConnection({ host: "127.0.0.1", port: mysqlPort, user: "demo_ro", password: "synthetic-readonly-password", database: "demo" });
    try {
      await assert.rejects(readonly.query("INSERT INTO demo_records(id) VALUES (99)"), { code: "ER_TABLEACCESS_DENIED_ERROR" });
      assertions++;
    } finally { await readonly.end(); }

    await call("redis_execute", { arguments: ["SET", "demo:key", "synthetic-value", "EX", "60"] });
    assert.equal((await call("redis_command", { arguments: ["GET", "demo:key"] })).result, "synthetic-value");
    await call("redis_scan_keys", { pattern: "demo:*", count: 10 });
    await blocked("redis_command", { arguments: ["KEYS", "*"] }, "REDIS_COMMAND_BLOCKED");
    await cache.set("demo:large", "x".repeat(60000));
    await blocked("redis_command", { arguments: ["GET", "demo:large"] }, "RESPONSE_TOO_LARGE");

    await call("mongo_insert_one", { collection: "demo_records", document: { marker: "synthetic", score: 1 } });
    await call("mongo_list_collections", { limit: 5 });
    const found = await call("mongo_find", { collection: "demo_records", filter: { marker: "synthetic" }, projection: { _id: 0, marker: 1, score: 1 } });
    assert.equal(found.documents[0].marker, "synthetic");
    await call("mongo_count_documents", { collection: "demo_records", filter: { marker: "synthetic" } });
    await call("mongo_aggregate", { collection: "demo_records", pipeline: [{ $match: { marker: "synthetic" } }] });
    await blocked("mongo_aggregate", { collection: "demo_records", pipeline: [{ $out: "blocked" }] }, "MONGO_WRITE_STAGE_BLOCKED");
    await call("mongo_update_many", { collection: "demo_records", filter: { marker: "synthetic" }, update: { $inc: { score: 1 } } });
    await blocked("mongo_delete_many", { collection: "demo_records", filter: {} }, "EMPTY_FILTER_BLOCKED");
    await call("mongo_delete_many", { collection: "demo_records", filter: { marker: "synthetic" } });
    await documents.db("demo").collection("large").insertOne({ value: "x".repeat(60000) });
    await blocked("mongo_find", { collection: "large", filter: {} }, "RESPONSE_TOO_LARGE");

    for (const [name, args] of [
      ["mysql_execute", { sql: "INSERT INTO demo_records(id) VALUES (98)" }],
      ["redis_execute", { arguments: ["SET", "demo:blocked", "value"] }],
      ["mongo_insert_one", { collection: "demo_records", document: { marker: "blocked" } }],
    ]) {
      await blocked(name, { ...args, connection_id: "local-disabled" }, "WRITE_DISABLED");
      await blocked(name, { ...args, connection_id: "prod-readonly" }, name === "mysql_execute" ? "PRODUCTION_WRITE_REJECTED" : "PRODUCTION_READ_ONLY");
    }
    process.stdout.write(JSON.stringify({ ok: true, assertions, providers: ["mysql", "redis", "mongo"], mysql_rollback: "verified", mysql_timeout_recovery: "verified", mysql_readonly_grants: "verified" }) + "\n");
  } finally {
    await client?.close();
    await sql?.end();
    if (cache?.isOpen) await cache.quit();
    await documents?.close();
    await fixture.close();
  }
}

main().catch(error => {
  process.stderr.write(`Isolated integration failed: ${error.code ?? error.name}.\n`);
  process.exitCode = 1;
});
