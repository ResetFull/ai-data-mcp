import { createClient } from "redis";
import { RedisConfigStore } from "./config.js";
import { DataMcpError } from "../errors.js";
import { runWrite } from "../write-policy.js";

interface RedisCommandClient {
  readonly isOpen: boolean;
  on(event: "error", listener: () => void): unknown;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  destroy(): void;
  sendCommand(args: string[]): Promise<unknown>;
}

export class RedisDatabaseManager {
  public constructor(private readonly configStore: RedisConfigStore) {}

  public async command(connectionId: string, args: string[], write = false): Promise<unknown> {
    const connection = await this.configStore.getConnection(connectionId);
    const password = await this.configStore.getPassword(connectionId);
    const client = createClient(toRedisClientOptions(connection, password)) as unknown as RedisCommandClient;
    client.on("error", () => process.stderr.write("[data-mcp] Redis transport error\n"));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DataMcpError(write ? "WRITE_OUTCOME_UNKNOWN" : "REDIS_TIMEOUT", write
          ? "The write exceeded its deadline. Its outcome is unknown; inspect the key before retrying."
          : "Redis operation exceeded its 15-second deadline."));
        if (client.isOpen) client.destroy();
      }, 15_000);
    });
    try {
      return await Promise.race([this.runCommand(client, args, write), timeout]);
    } finally {
      clearTimeout(timer);
      if (client.isOpen) client.destroy();
    }
  }

  private async runCommand(client: RedisCommandClient, args: string[], write: boolean): Promise<unknown> {
    try {
      await client.connect();
      return await (write ? runWrite(() => client.sendCommand(args)) : client.sendCommand(args));
    } finally {
      if (client.isOpen) {
        try {
          await client.quit();
        } catch {
          if (client.isOpen) client.destroy();
        }
      }
    }
  }
}

export function toRedisClientOptions(
  connection: Awaited<ReturnType<RedisConfigStore["getConnection"]>>,
  password: string | undefined,
): Parameters<typeof createClient>[0] {
  return {
    RESP: 2,
    socket: {
      host: connection.host,
      port: connection.port,
      connectTimeout: connection.connectTimeoutMs,
      reconnectStrategy: false,
      ...(connection.tls ? { tls: true } : {}),
    },
    database: connection.database,
    ...(connection.username ? { username: connection.username } : {}),
    ...(password ? { password } : {}),
  };
}
