import { DataConfigStore, type MongoConnectionConfig } from "../config.js";
import { DataMcpError } from "../errors.js";

export interface PublicMongoConnectionConfig {
  id: string;
  environment: MongoConnectionConfig["environment"];
  access_mode: "read-only" | "read-write";
  database: string;
  max_pool_size: number;
}

export class MongoConfigStore {
  public constructor(private readonly dataConfigStore: DataConfigStore) {}

  public async listConnections(): Promise<PublicMongoConnectionConfig[]> {
    const connections = (await this.dataConfigStore.load()).configuration.mongo?.connections ?? [];
    return connections.map((connection) => ({
      id: connection.id,
      environment: connection.environment,
      access_mode: connection.environment !== "prod" && connection.write_enabled ? "read-write" : "read-only",
      database: connection.database,
      max_pool_size: connection.maxPoolSize,
    }));
  }

  public async getConnection(id: string): Promise<MongoConnectionConfig> {
    const connections = (await this.dataConfigStore.load()).configuration.mongo?.connections ?? [];
    const connection = connections.find((candidate) => candidate.id === id);
    if (!connection) {
      throw new DataMcpError(
        "UNKNOWN_CONNECTION",
        `Unknown MongoDB connection '${id}'. Available connections: ${connections.map(({ id: connectionId }) => connectionId).join(", ")}.`,
      );
    }
    return connection;
  }

  public async getUri(id: string): Promise<string> {
    const secret = (await this.dataConfigStore.load()).secrets.mongo?.[id];
    if (!secret) {
      throw new DataMcpError(
        "MISSING_SECRET",
        `No MongoDB URI is configured for connection '${id}'. Add it under mongo.${id}.uri in DATA_MCP_SECRETS_JSON or the secrets file.`,
      );
    }
    return secret.uri;
  }
}
