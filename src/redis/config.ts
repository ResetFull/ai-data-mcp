import { DataConfigStore, type RedisConnectionConfig } from "../config.js";
import { DataMcpError } from "../errors.js";

export interface PublicRedisConnectionConfig {
  id: string;
  environment: RedisConnectionConfig["environment"];
  access_mode: "read-only" | "read-write";
  host: string;
  port: number;
  database: number;
  username?: string;
  tls: boolean;
}

export class RedisConfigStore {
  public constructor(private readonly dataConfigStore: DataConfigStore) {}

  public async listConnections(): Promise<PublicRedisConnectionConfig[]> {
    const connections = (await this.dataConfigStore.load()).configuration.redis?.connections ?? [];
    return connections.map((connection) => ({
      id: connection.id,
      environment: connection.environment,
      access_mode: connection.environment !== "prod" && connection.write_enabled ? "read-write" : "read-only",
      host: connection.host,
      port: connection.port,
      database: connection.database,
      ...(connection.username ? { username: connection.username } : {}),
      tls: connection.tls,
    }));
  }

  public async getConnection(id: string): Promise<RedisConnectionConfig> {
    const connections = (await this.dataConfigStore.load()).configuration.redis?.connections ?? [];
    const connection = connections.find((candidate) => candidate.id === id);
    if (!connection) {
      throw new DataMcpError(
        "UNKNOWN_CONNECTION",
        `Unknown Redis connection '${id}'. Available connections: ${connections.map(({ id: connectionId }) => connectionId).join(", ")}.`,
      );
    }
    return connection;
  }

  public async getPassword(id: string): Promise<string | undefined> {
    return (await this.dataConfigStore.load()).secrets.redis?.[id]?.password;
  }
}
