import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { DataMcpError } from "../errors.js";
import { formatOutput, markdownTable } from "../format.js";
import { safely, success, type PublicToolError, type ToolResult } from "../tool-result.js";
import { RedisConfigStore } from "./config.js";
import { RedisDatabaseManager } from "./database.js";
import { assertRedisReadCommand, assertRedisWriteCommand } from "./policy.js";

const ResponseFormatSchema = z.enum(["markdown", "json"]).default("markdown");
const ConnectionIdSchema = z.string().min(1).max(64);
const CommandArgumentsSchema = z.array(z.string().max(65_536)).min(1).max(100)
  .describe("Redis command name followed by already-tokenized arguments. Do not pass one shell-style command string.");
const ListConnectionsInputSchema = mcpSchema(z.object({ response_format: ResponseFormatSchema }).strict());
const ScanKeysInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  cursor: z.string().regex(/^\d+$/).default("0"),
  pattern: z.string().min(1).max(1024).default("*"),
  count: z.number().int().min(1).max(500).default(100),
  type: z.enum(["string", "list", "set", "zset", "hash", "stream"]).optional(),
  response_format: ResponseFormatSchema,
}).strict());
const CommandInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  arguments: CommandArgumentsSchema,
  response_format: ResponseFormatSchema,
}).strict());

export function registerRedisTools(server: McpServer, configStore: RedisConfigStore, database: RedisDatabaseManager): void {
  server.registerTool<StandardSchemaWithJSON, typeof ListConnectionsInputSchema>(
    "redis_list_connections",
    {
      title: "List Redis connections",
      description: "List configured Redis connection IDs, environments, logical databases, and effective access modes. Passwords are never returned.",
      inputSchema: ListConnectionsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }): Promise<ToolResult> => redisSafely(async () => {
      const connections = await configStore.listConnections();
      const output = { count: connections.length, connections };
      return success(output, formatOutput(output, response_format, () => [
        "# Redis connections",
        "",
        markdownTable(connections.map((connection) => ({ ...connection }))),
      ].join("\n")));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof ScanKeysInputSchema>(
    "redis_scan_keys",
    {
      title: "Scan Redis keys",
      description: "Incrementally scan Redis keys without using the blocking KEYS command. Returns the next cursor and a bounded page of keys.",
      inputSchema: ScanKeysInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ connection_id, cursor, pattern, count, type, response_format }): Promise<ToolResult> => redisSafely(async () => {
      const args = ["SCAN", cursor, "MATCH", pattern, "COUNT", String(count), ...(type ? ["TYPE", type] : [])];
      const [nextCursor, keys] = parseScanResult(await database.command(connection_id, args));
      const output = {
        connection_id,
        cursor,
        next_cursor: nextCursor,
        complete: nextCursor === "0",
        count: keys.length,
        keys,
      };
      return success(output, formatOutput(output, response_format, () => [
        `# Redis keys: ${connection_id}`,
        "",
        `${keys.length} key(s); next cursor: ${nextCursor}.`,
        "",
        ...keys.map((key) => `- ${key}`),
      ].join("\n")));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof CommandInputSchema>(
    "redis_command",
    {
      title: "Run read-only Redis command",
      description: "Run one explicitly allowlisted read-only Redis command with tokenized arguments. KEYS, scripting, administration, pub/sub, transactions, blocking operations, and all mutations are rejected.",
      inputSchema: CommandInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, arguments: commandArguments, response_format }): Promise<ToolResult> => redisSafely(async () => {
      const command = assertRedisReadCommand(commandArguments);
      const result = normalizeRedisValue(await database.command(connection_id, commandArguments));
      const output = { connection_id, command, result };
      return success(output, formatOutput(output, response_format, () => [
        `# Redis ${command}: ${connection_id}`,
        "",
        "```json",
        JSON.stringify(result, null, 2),
        "```",
      ].join("\n")));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof CommandInputSchema>(
    "redis_execute",
    {
      title: "Execute non-production Redis command",
      description: "Execute one explicitly allowlisted Redis mutation on a non-production connection. Production, scripts, transactions, administration, pub/sub, flush, and arbitrary commands are rejected.",
      inputSchema: CommandInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ connection_id, arguments: commandArguments, response_format }): Promise<ToolResult> => redisSafely(async () => {
      const connection = await configStore.getConnection(connection_id);
      const command = assertRedisWriteCommand(commandArguments, connection.environment, connection.write_enabled);
      const result = normalizeRedisValue(await database.command(connection_id, commandArguments, true));
      const output = { connection_id, command, result };
      return success(output, formatOutput(output, response_format, () => [
        `# Redis ${command} executed: ${connection_id}`,
        "",
        "```json",
        JSON.stringify(result, null, 2),
        "```",
      ].join("\n")));
    }),
  );
}

function parseScanResult(value: unknown): [string, string[]] {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || (typeof value[0] !== "string" && typeof value[0] !== "number")
    || !Array.isArray(value[1])
  ) {
    throw new DataMcpError("INVALID_REDIS_RESPONSE", "Redis returned an unexpected SCAN response.");
  }
  return [String(value[0]), value[1].map(String)];
}

function normalizeRedisValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRedisValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeRedisValue(item)]));
  }
  return value;
}

function redisSafely(operation: () => Promise<ToolResult>): Promise<ToolResult> {
  return safely(operation, toRedisPublicError);
}

function toRedisPublicError(error: unknown): PublicToolError {
  if (error instanceof DataMcpError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "REDIS_ERROR",
    message: "Redis operation failed. Verify the connection, credentials, command arguments, and server availability.",
  };
}

function mcpSchema<T extends z.ZodType>(schema: T): T & StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  return schema as T & StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}
