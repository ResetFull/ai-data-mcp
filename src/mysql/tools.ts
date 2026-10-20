import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { MysqlConfigStore } from "./config.js";
import type { MysqlDatabaseManager, SqlParameter } from "./database.js";
import { formatOutput, markdownTable } from "../format.js";
import { toMysqlPublicError } from "./errors.js";
import { success, safely as safelyResult } from "../tool-result.js";

const ResponseFormatSchema = z.enum(["markdown", "json"]).default("markdown").describe("Response rendering: markdown for humans or json for programmatic processing.");
const ConnectionIdSchema = z.string().min(1).max(64).describe("Configured connection ID, for example prod-main or test-main.");
const SqlParameterSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const SqlParametersSchema = z.array(SqlParameterSchema).max(200).default([]).describe("Positional values for SQL ? placeholders. Values may be string, finite number, boolean, or null.");
const TimeoutSchema = z.number().int().min(1000).max(120000).default(15000).describe("Client-side query timeout in milliseconds, from 1000 through 120000.");

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function registerMysqlTools(server: McpServer, configStore: MysqlConfigStore, database: MysqlDatabaseManager): void {
  registerListConnections(server, configStore);
  registerListTables(server, database);
  registerDescribeTable(server, database);
  registerQuery(server, database);
  registerExecute(server, database);
  registerExecuteTransaction(server, database);
}

function registerListConnections(server: McpServer, configStore: MysqlConfigStore): void {
  const inputSchema = z.object({ response_format: ResponseFormatSchema }).strict();
  server.registerTool(
    "mysql_list_connections",
    {
      title: "List MySQL connections",
      description: "List configured MySQL connection IDs, environments, databases, and effective access modes. Passwords are never returned. Use this before other tools when the connection ID is unknown.",
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }): Promise<ToolResult> => safely(async () => {
      const connections = await configStore.listConnections();
      const output = { count: connections.length, connections };
      return success(output, formatOutput(output, response_format, () => [
        "# MySQL connections",
        "",
        markdownTable(connections.map((connection) => ({ ...connection }))),
      ].join("\n")));
    }),
  );
}

function registerListTables(server: McpServer, database: MysqlDatabaseManager): void {
  const inputSchema = z.object({
    connection_id: ConnectionIdSchema,
    schema: z.string().min(1).max(64).optional().describe("Schema to inspect. Defaults to the connection's configured database."),
    name_contains: z.string().min(1).max(64).optional().describe("Optional case-insensitive substring filter for table names."),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    response_format: ResponseFormatSchema,
  }).strict();
  server.registerTool(
    "mysql_list_tables",
    {
      title: "List MySQL tables",
      description: "List tables and views in a MySQL schema with pagination and an optional name filter. Returns table type, engine, row estimate, and storage size. This tool is read-only in every environment.",
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, schema, name_contains, limit, offset, response_format }): Promise<ToolResult> => safely(async () => {
      const connection = await getConnectionDatabase(database, connection_id, schema);
      const where = name_contains ? "AND LOWER(table_name) LIKE LOWER(?)" : "";
      const filterParameters: SqlParameter[] = name_contains ? [connection.schema, `%${name_contains}%`] : [connection.schema];
      const listSql = `
        SELECT table_schema, table_name, table_type, engine, table_rows,
               data_length + index_length AS size_bytes
        FROM information_schema.tables
        WHERE table_schema = ? ${where}
        ORDER BY table_name
        LIMIT ? OFFSET ?`;
      const countSql = `
        SELECT COUNT(*) AS total_count
        FROM information_schema.tables
        WHERE table_schema = ? ${where}`;
      const [listResult, countResult] = await Promise.all([
        database.query(connection_id, listSql, [...filterParameters, limit, offset], limit, 15000),
        database.query(connection_id, countSql, filterParameters, 1, 15000),
      ]);
      const totalCount = Number(countResult.rows[0]?.total_count ?? 0);
      const output = {
        connection_id,
        schema: connection.schema,
        total_count: totalCount,
        count: listResult.rows.length,
        offset,
        tables: listResult.rows,
        has_more: offset + listResult.rows.length < totalCount,
        ...(offset + listResult.rows.length < totalCount ? { next_offset: offset + listResult.rows.length } : {}),
      };
      return success(output, formatOutput(output, response_format, () => [
        `# Tables in ${connection.schema}`,
        "",
        `${totalCount} total; showing ${listResult.rows.length} from offset ${offset}.`,
        "",
        markdownTable(listResult.rows),
      ].join("\n")));
    }),
  );
}

function registerDescribeTable(server: McpServer, database: MysqlDatabaseManager): void {
  const inputSchema = z.object({
    connection_id: ConnectionIdSchema,
    table: z.string().min(1).max(64).describe("Exact table or view name."),
    schema: z.string().min(1).max(64).optional().describe("Schema name. Defaults to the connection's configured database."),
    response_format: ResponseFormatSchema,
  }).strict();
  server.registerTool(
    "mysql_describe_table",
    {
      title: "Describe MySQL table",
      description: "Inspect columns and indexes for one exact MySQL table or view. Returns types, nullability, defaults, comments, and ordered index columns. This tool is read-only in every environment.",
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, table, schema, response_format }): Promise<ToolResult> => safely(async () => {
      const connection = await getConnectionDatabase(database, connection_id, schema);
      const columnSql = `
        SELECT ordinal_position, column_name, column_type, is_nullable, column_default,
               column_key, extra, column_comment
        FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`;
      const indexSql = `
        SELECT index_name, non_unique, seq_in_index, column_name, sub_part, index_type
        FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ?
        ORDER BY index_name, seq_in_index`;
      const [columnResult, indexResult] = await Promise.all([
        database.query(connection_id, columnSql, [connection.schema, table], 1000, 15000),
        database.query(connection_id, indexSql, [connection.schema, table], 1000, 15000),
      ]);
      if (columnResult.rows.length === 0) {
        throw new Error(`Table or view '${connection.schema}.${table}' was not found or is not visible to the configured user.`);
      }
      const output = {
        connection_id,
        schema: connection.schema,
        table,
        columns: columnResult.rows,
        indexes: indexResult.rows,
      };
      return success(output, formatOutput(output, response_format, () => [
        `# ${connection.schema}.${table}`,
        "",
        "## Columns",
        "",
        markdownTable(columnResult.rows),
        "",
        "## Indexes",
        "",
        markdownTable(indexResult.rows),
      ].join("\n")));
    }),
  );
}

function registerQuery(server: McpServer, database: MysqlDatabaseManager): void {
  const inputSchema = z.object({
    connection_id: ConnectionIdSchema,
    sql: z.string().min(1).max(100_000).describe("Exactly one read-only MySQL SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN statement. Use ? placeholders for values."),
    parameters: SqlParametersSchema,
    max_rows: z.number().int().min(1).max(1000).default(200).describe("Maximum rows returned to the model."),
    timeout_ms: TimeoutSchema,
    response_format: ResponseFormatSchema,
  }).strict();
  server.registerTool(
    "mysql_query",
    {
      title: "Query MySQL",
      description: "Run exactly one parameterized read-only MySQL statement. Works in every environment, including prod. Data MCP rejects writes, locking reads, file access, session mutation, multiple statements, and selected resource-exhaustion functions; it also runs the statement in a read-only transaction and caps returned data.",
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, sql, parameters, max_rows, timeout_ms, response_format }): Promise<ToolResult> => safely(async () => {
      const result = await database.query(connection_id, sql, parameters, max_rows, timeout_ms);
      const output = { ...result, max_rows };
      return success(output, formatOutput(output, response_format, () => [
        `# Query result: ${connection_id}`,
        "",
        `${result.row_count} row(s)${result.truncated ? "; output truncated" : ""}.`,
        "",
        markdownTable(result.rows, result.columns),
      ].join("\n")));
    }),
  );
}

function registerExecute(server: McpServer, database: MysqlDatabaseManager): void {
  const inputSchema = z.object({
    connection_id: ConnectionIdSchema,
    sql: z.string().min(1).max(100_000).describe("Exactly one non-read SQL statement. Prod connections and explicit transaction/session-control statements are rejected."),
    parameters: SqlParametersSchema,
    allow_all: z.boolean().default(false).describe("Explicitly permit UPDATE or DELETE without WHERE."),
    allow_ddl: z.boolean().default(false).describe("Explicitly permit DDL, which may implicitly commit and cannot reliably be rolled back."),
    timeout_ms: TimeoutSchema,
    response_format: ResponseFormatSchema,
  }).strict();
  server.registerTool(
    "mysql_execute",
    {
      title: "Execute non-production MySQL statement",
      description: "Execute one parameterized DML or DDL statement on a non-production connection. Never runs against a connection marked prod. Use mysql_execute_transaction for atomic multi-statement DML; run DDL separately because MySQL may implicitly commit it.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ connection_id, sql, parameters, allow_all, allow_ddl, timeout_ms, response_format }): Promise<ToolResult> => safely(async () => {
      const result = await database.execute(connection_id, sql, parameters, timeout_ms, { allowAll: allow_all, allowDdl: allow_ddl });
      const output = { connection_id, ...result };
      return success(output, formatOutput(output, response_format, () => executionMarkdown(connection_id, { ...result })));
    }),
  );
}

function registerExecuteTransaction(server: McpServer, database: MysqlDatabaseManager): void {
  const statementSchema = z.object({
    sql: z.string().min(1).max(100_000),
    parameters: SqlParametersSchema,
  }).strict();
  const inputSchema = z.object({
    connection_id: ConnectionIdSchema,
    statements: z.array(statementSchema).min(1).max(20).describe("Ordered INSERT, REPLACE, UPDATE, or DELETE statements committed atomically."),
    timeout_ms: TimeoutSchema,
    allow_all: z.boolean().default(false).describe("Explicitly permit transaction UPDATE or DELETE statements without WHERE."),
    response_format: ResponseFormatSchema,
  }).strict();
  server.registerTool(
    "mysql_execute_transaction",
    {
      title: "Execute non-production MySQL transaction",
      description: "Atomically execute 1-20 parameterized INSERT, REPLACE, UPDATE, or DELETE statements on one non-production connection. Rolls back on the first error. Prod, DDL, reads, transaction control, and session control are rejected.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ connection_id, statements, allow_all, timeout_ms, response_format }): Promise<ToolResult> => safely(async () => {
      const result = await database.executeTransaction(connection_id, statements, timeout_ms, allow_all);
      const output = { ...result };
      return success(output, formatOutput(output, response_format, () => [
        `# Transaction committed: ${connection_id}`,
        "",
        `${result.statements.length} statement(s), ${result.total_affected_rows} total affected row(s).`,
        "",
        markdownTable(result.statements.map((statement) => ({ ...statement }))),
      ].join("\n")));
    }),
  );
}

async function getConnectionDatabase(database: MysqlDatabaseManager, connectionId: string, schema: string | undefined): Promise<{ schema: string }> {
  if (schema) {
    return { schema };
  }
  const result = await database.query(connectionId, "SELECT DATABASE() AS database_name", [], 1, 5000);
  const databaseName = result.rows[0]?.database_name;
  if (typeof databaseName !== "string" || !databaseName) {
    throw new Error(`Connection '${connectionId}' does not have a default database.`);
  }
  return { schema: databaseName };
}

function executionMarkdown(connectionId: string, result: Record<string, unknown>): string {
  return [
    `# Statement executed: ${connectionId}`,
    "",
    markdownTable([result]),
  ].join("\n");
}

async function safely(operation: () => Promise<ToolResult>): Promise<ToolResult> {
  return safelyResult(operation, toMysqlPublicError);
}
