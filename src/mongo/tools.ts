import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { Document, Filter, UpdateFilter } from "mongodb";
import { z } from "zod/v4";
import { DataMcpError } from "../errors.js";
import { formatOutput, markdownTable } from "../format.js";
import { safely, success, type PublicToolError, type ToolResult } from "../tool-result.js";
import { MongoConfigStore } from "./config.js";
import { MongoDatabaseManager } from "./database.js";
import { assertMongoWriteAllowed, assertReadOnlyPipeline } from "./policy.js";

const ResponseFormatSchema = z.enum(["markdown", "json"]).default("markdown");
const ConnectionIdSchema = z.string().min(1).max(64);
const CollectionSchema = z.string().min(1).max(255);
const DocumentSchema = z.record(z.string(), z.unknown());
const TimeoutSchema = z.number().int().min(1000).max(120000).default(15000);
const ListConnectionsInputSchema = mcpSchema(z.object({ response_format: ResponseFormatSchema }).strict());
const ListCollectionsInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  name_contains: z.string().min(1).max(255).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  response_format: ResponseFormatSchema,
}).strict());
const FindInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  collection: CollectionSchema,
  filter: DocumentSchema.default({}),
  projection: DocumentSchema.optional(),
  sort: DocumentSchema.optional(),
  skip: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(200).default(50),
  timeout_ms: TimeoutSchema,
  response_format: ResponseFormatSchema,
}).strict());
const CountInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  collection: CollectionSchema,
  filter: DocumentSchema.default({}),
  timeout_ms: TimeoutSchema,
  response_format: ResponseFormatSchema,
}).strict());
const AggregateInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  collection: CollectionSchema,
  pipeline: z.array(DocumentSchema).max(50).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  timeout_ms: TimeoutSchema,
  response_format: ResponseFormatSchema,
}).strict());
const InsertInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  collection: CollectionSchema,
  document: DocumentSchema,
  response_format: ResponseFormatSchema,
}).strict());
const UpdateInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  collection: CollectionSchema,
  filter: DocumentSchema,
  update: DocumentSchema,
  allow_all: z.boolean().default(false),
  response_format: ResponseFormatSchema,
}).strict());
const DeleteInputSchema = mcpSchema(z.object({
  connection_id: ConnectionIdSchema,
  collection: CollectionSchema,
  filter: DocumentSchema,
  allow_all: z.boolean().default(false),
  response_format: ResponseFormatSchema,
}).strict());

export function registerMongoTools(
  server: McpServer,
  configStore: MongoConfigStore,
  database: MongoDatabaseManager,
): void {
  server.registerTool<StandardSchemaWithJSON, typeof ListConnectionsInputSchema>(
    "mongo_list_connections",
    {
      title: "List MongoDB connections",
      description: "List configured MongoDB connection IDs, environments, databases, and effective access modes. Connection URIs and credentials are never returned.",
      inputSchema: ListConnectionsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const connections = await configStore.listConnections();
      const output = { count: connections.length, connections };
      return success(output, formatOutput(output, response_format, () => [
        "# MongoDB connections",
        "",
        markdownTable(connections.map((connection) => ({ ...connection }))),
      ].join("\n")));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof ListCollectionsInputSchema>(
    "mongo_list_collections",
    {
      title: "List MongoDB collections",
      description: "List MongoDB collections and metadata with a bounded result size and optional case-insensitive name filter.",
      inputSchema: ListCollectionsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, name_contains, limit, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const result = await database.listCollections(connection_id, name_contains, limit);
      const output = {
        connection_id,
        count: result.documents.length,
        collections: result.documents,
        has_more: result.has_more,
      };
      return success(output, formatOutput(output, response_format, () => jsonMarkdown(
        `MongoDB collections: ${connection_id}`,
        result.documents,
      )));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof FindInputSchema>(
    "mongo_find",
    {
      title: "Find MongoDB documents",
      description: "Run a bounded MongoDB find query with filter, projection, sort, skip, and max-time controls. This tool is read-only in every environment.",
      inputSchema: FindInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, collection, filter, projection, sort, skip, limit, timeout_ms, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const result = await database.find(
        connection_id,
        collection,
        filter as Filter<Document>,
        projection,
        sort,
        skip,
        limit,
        timeout_ms,
      );
      const output = {
        connection_id,
        collection,
        count: result.documents.length,
        skip,
        documents: result.documents,
        has_more: result.has_more,
        ...(result.has_more ? { next_skip: skip + result.documents.length } : {}),
      };
      return success(output, formatOutput(output, response_format, () => jsonMarkdown(
        `MongoDB find: ${connection_id}/${collection}`,
        result.documents,
      )));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof CountInputSchema>(
    "mongo_count_documents",
    {
      title: "Count MongoDB documents",
      description: "Count documents matching a MongoDB filter with a bounded max execution time. This tool is read-only in every environment.",
      inputSchema: CountInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, collection, filter, timeout_ms, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const count = await database.count(connection_id, collection, filter as Filter<Document>, timeout_ms);
      const output = { connection_id, collection, count };
      return success(output, formatOutput(output, response_format, () => [
        `# MongoDB count: ${connection_id}/${collection}`,
        "",
        String(count),
      ].join("\n")));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof AggregateInputSchema>(
    "mongo_aggregate",
    {
      title: "Aggregate MongoDB documents",
      description: "Run a bounded read-only MongoDB aggregation. Data MCP recursively rejects $out and $merge stages and appends a result limit.",
      inputSchema: AggregateInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, collection, pipeline, limit, timeout_ms, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      assertReadOnlyPipeline(pipeline);
      const result = await database.aggregate(connection_id, collection, pipeline, limit, timeout_ms);
      const output = {
        connection_id,
        collection,
        count: result.documents.length,
        documents: result.documents,
        has_more: result.has_more,
      };
      return success(output, formatOutput(output, response_format, () => jsonMarkdown(
        `MongoDB aggregate: ${connection_id}/${collection}`,
        result.documents,
      )));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof InsertInputSchema>(
    "mongo_insert_one",
    {
      title: "Insert non-production MongoDB document",
      description: "Insert one document into a non-production MongoDB collection. Production connections are always read-only.",
      inputSchema: InsertInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ connection_id, collection, document, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const connection = await configStore.getConnection(connection_id);
      assertMongoWriteAllowed(connection.environment, { insert: true }, false, connection.write_enabled);
      const result = await database.insertOne(connection_id, collection, document);
      const output = { connection_id, collection, result };
      return success(output, formatOutput(output, response_format, () => jsonMarkdown(
        `MongoDB document inserted: ${connection_id}/${collection}`,
        result,
      )));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof UpdateInputSchema>(
    "mongo_update_many",
    {
      title: "Update non-production MongoDB documents",
      description: "Update matching documents in a non-production collection. Empty filters require allow_all=true; production is always blocked.",
      inputSchema: UpdateInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ connection_id, collection, filter, update, allow_all, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const connection = await configStore.getConnection(connection_id);
      assertMongoWriteAllowed(connection.environment, filter, allow_all, connection.write_enabled);
      assertUpdateDocument(update);
      const result = await database.updateMany(
        connection_id,
        collection,
        filter as Filter<Document>,
        update as UpdateFilter<Document>,
      );
      const output = { connection_id, collection, result };
      return success(output, formatOutput(output, response_format, () => jsonMarkdown(
        `MongoDB documents updated: ${connection_id}/${collection}`,
        result,
      )));
    }),
  );

  server.registerTool<StandardSchemaWithJSON, typeof DeleteInputSchema>(
    "mongo_delete_many",
    {
      title: "Delete non-production MongoDB documents",
      description: "Delete matching documents from a non-production collection. Empty filters require allow_all=true; production is always blocked.",
      inputSchema: DeleteInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ connection_id, collection, filter, allow_all, response_format }): Promise<ToolResult> => mongoSafely(async () => {
      const connection = await configStore.getConnection(connection_id);
      assertMongoWriteAllowed(connection.environment, filter, allow_all, connection.write_enabled);
      const result = await database.deleteMany(connection_id, collection, filter as Filter<Document>);
      const output = { connection_id, collection, result };
      return success(output, formatOutput(output, response_format, () => jsonMarkdown(
        `MongoDB documents deleted: ${connection_id}/${collection}`,
        result,
      )));
    }),
  );
}

function assertUpdateDocument(update: Record<string, unknown>): void {
  if (Object.keys(update).length === 0 || !Object.keys(update).every((key) => key.startsWith("$"))) {
    throw new DataMcpError(
      "INVALID_MONGO_UPDATE",
      "MongoDB update must be a non-empty operator document such as {$set: {...}}; full-document replacements are not accepted by mongo_update_many.",
    );
  }
}

function jsonMarkdown(title: string, value: unknown): string {
  return [`# ${title}`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function mongoSafely(operation: () => Promise<ToolResult>): Promise<ToolResult> {
  return safely(operation, toMongoPublicError);
}

function toMongoPublicError(error: unknown): PublicToolError {
  if (error instanceof DataMcpError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "MONGO_ERROR",
    message: "MongoDB operation failed. Verify the connection URI, database, query document, permissions, and server availability.",
  };
}

function mcpSchema<T extends z.ZodType>(schema: T): T & StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  return schema as T & StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}
