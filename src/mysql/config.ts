import {
  DataConfigStore,
  MysqlConnectionConfigSchema,
  type MysqlConnectionConfig,
} from "../config.js";
import { DataMcpError } from "../errors.js";

export { MysqlConnectionConfigSchema };
export type { MysqlConnectionConfig };

export interface PublicMysqlConnectionConfig {
  id: string;
  environment: MysqlConnectionConfig["environment"];
  access_mode: "read-only" | "read-write";
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
}

export class MysqlConfigStore {
  public constructor(private readonly dataConfigStore = new DataConfigStore()) {}

  public async listConnections(): Promise<PublicMysqlConnectionConfig[]> {
    const connections = (await this.dataConfigStore.load()).configuration.mysql?.connections ?? [];
    return connections.map(toPublicConnection);
  }

  public async getConnection(id: string): Promise<MysqlConnectionConfig> {
    const connections = (await this.dataConfigStore.load()).configuration.mysql?.connections ?? [];
    const connection = connections.find((candidate) => candidate.id === id);
    if (!connection) {
      throw new DataMcpError(
        "UNKNOWN_CONNECTION",
        `Unknown MySQL connection '${id}'. Available connections: ${connections.map(({ id: connectionId }) => connectionId).join(", ")}.`,
      );
    }
    return connection;
  }

  public async getPassword(id: string): Promise<string> {
    const secret = (await this.dataConfigStore.load()).secrets.mysql?.[id];
    if (!secret) {
      throw new DataMcpError(
        "MISSING_SECRET",
        `No MySQL password is configured for connection '${id}'. Add it under mysql.${id} in DATA_MCP_SECRETS_JSON or the secrets file.`,
      );
    }
    return secret.password;
  }
}

function toPublicConnection(connection: MysqlConnectionConfig): PublicMysqlConnectionConfig {
  return {
    id: connection.id,
    environment: connection.environment,
    access_mode: connection.environment !== "prod" && connection.write_enabled ? "read-write" : "read-only",
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ssl: connection.ssl,
  };
}
