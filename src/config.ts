import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { DataMcpError } from "./errors.js";

export const EnvironmentSchema = z.enum(["prod", "staging", "test", "dev", "local"]);
const ConnectionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "id must be lower-case kebab-case and at most 64 characters");

export const MysqlConnectionConfigSchema = z.object({
  id: ConnectionIdSchema,
  environment: EnvironmentSchema,
  write_enabled: z.boolean().default(false),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(3306),
  database: z.string().min(1).max(64),
  user: z.string().min(1).max(128),
  ssl: z.boolean().default(false),
  // Kept for backwards-compatible config parsing; the middleware does not use it as a client-side cap.
  connectionLimit: z.number().int().min(0).default(0),
  connectTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
}).strict();

export const RedisConnectionConfigSchema = z.object({
  id: ConnectionIdSchema,
  environment: EnvironmentSchema,
  write_enabled: z.boolean().default(false),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(6379),
  database: z.number().int().min(0).max(15).default(0),
  username: z.string().min(1).max(128).optional(),
  tls: z.boolean().default(false),
  connectTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
}).strict();

export const MongoConnectionConfigSchema = z.object({
  id: ConnectionIdSchema,
  environment: EnvironmentSchema,
  write_enabled: z.boolean().default(false),
  database: z.string().min(1).max(128),
  maxPoolSize: z.number().int().min(1).max(20).default(5),
  connectTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
}).strict();

const MysqlProviderSchema = providerSchema(MysqlConnectionConfigSchema);
const RedisProviderSchema = providerSchema(RedisConnectionConfigSchema);
const MongoProviderSchema = providerSchema(MongoConnectionConfigSchema);

export const DataMcpConfigSchema = z.object({
  mysql: MysqlProviderSchema.optional(),
  redis: RedisProviderSchema.optional(),
  mongo: MongoProviderSchema.optional(),
}).strict().superRefine((configuration, context) => {
  if (!configuration.mysql && !configuration.redis && !configuration.mongo) {
    context.addIssue({ code: "custom", message: "at least one data provider must be configured" });
  }
});

const MysqlSecretSchema = z.object({ password: z.string().min(1) }).strict();
const RedisSecretSchema = z.object({ password: z.string().min(1).optional() }).strict();
const MongoSecretSchema = z.object({
  uri: z.string().min(1).refine(
    (value) => value.startsWith("mongodb://") || value.startsWith("mongodb+srv://"),
    "uri must use mongodb:// or mongodb+srv://",
  ),
}).strict();

export const DataMcpSecretsSchema = z.object({
  mysql: z.record(z.string(), MysqlSecretSchema).optional(),
  redis: z.record(z.string(), RedisSecretSchema).optional(),
  mongo: z.record(z.string(), MongoSecretSchema).optional(),
}).strict();

export type Environment = z.infer<typeof EnvironmentSchema>;
export type MysqlConnectionConfig = z.infer<typeof MysqlConnectionConfigSchema>;
export type RedisConnectionConfig = z.infer<typeof RedisConnectionConfigSchema>;
export type MongoConnectionConfig = z.infer<typeof MongoConnectionConfigSchema>;
export type DataMcpConfiguration = z.infer<typeof DataMcpConfigSchema>;
export type DataMcpSecrets = z.infer<typeof DataMcpSecretsSchema>;

export interface LoadedDataConfiguration {
  configuration: DataMcpConfiguration;
  secrets: DataMcpSecrets;
}

export class DataConfigStore {
  private cachedConfiguration?: LoadedDataConfiguration;

  public async load(): Promise<LoadedDataConfiguration> {
    if (this.cachedConfiguration) {
      return this.cachedConfiguration;
    }

    const baseDirectory = join(homedir(), ".config", "data-mcp");
    const connectionsPath = process.env.DATA_MCP_CONFIG ?? join(baseDirectory, "connections.json");
    const connectionsJson = await readJsonFile(connectionsPath, "connection configuration");
    const configuration = parseSchema(DataMcpConfigSchema, connectionsJson, "Data MCP configuration");
    const secretsJson = process.env.DATA_MCP_SECRETS_JSON
      ? parseJson(process.env.DATA_MCP_SECRETS_JSON, "DATA_MCP_SECRETS_JSON")
      : await readJsonFile(process.env.DATA_MCP_SECRETS_FILE ?? join(baseDirectory, "secrets.json"), "secrets file");
    const secrets = parseSchema(DataMcpSecretsSchema, secretsJson, "Data MCP secrets configuration");

    this.cachedConfiguration = { configuration, secrets };
    return this.cachedConfiguration;
  }
}

function providerSchema<T extends z.ZodType<{ id: string }>>(connectionSchema: T): z.ZodType<{ connections: Array<z.infer<T>> }> {
  return z.object({ connections: z.array(connectionSchema).min(1).max(50) }).strict().superRefine(({ connections }, context) => {
    const ids = new Set<string>();
    for (const connection of connections) {
      if (ids.has(connection.id)) {
        context.addIssue({ code: "custom", message: `duplicate connection id: ${connection.id}`, path: ["connections"] });
      }
      ids.add(connection.id);
    }
  }) as z.ZodType<{ connections: Array<z.infer<T>> }>;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  try {
    return parseJson(await readFile(path, "utf8"), label);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new DataMcpError("CONFIG_NOT_FOUND", `The ${label} was not found. Run npm run config:init and follow docs/configuration.md, then restart the Data MCP process.`);
    }
    throw error;
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DataMcpError("INVALID_JSON", `The ${label} is not valid JSON.`);
  }
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
  throw new DataMcpError("INVALID_CONFIG", `Invalid ${label}: ${details}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
