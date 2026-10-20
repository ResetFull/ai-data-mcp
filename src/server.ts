import { McpServer } from "@modelcontextprotocol/server";
import { DataConfigStore } from "./config.js";
import { MongoConfigStore } from "./mongo/config.js";
import { MongoDatabaseManager } from "./mongo/database.js";
import { registerMongoTools } from "./mongo/tools.js";
import { MysqlConfigStore } from "./mysql/config.js";
import { MysqlDatabaseManager } from "./mysql/database.js";
import { registerMysqlTools } from "./mysql/tools.js";
import { RedisConfigStore } from "./redis/config.js";
import { RedisDatabaseManager } from "./redis/database.js";
import { registerRedisTools } from "./redis/tools.js";
import { VERSION } from "./version.js";

export function createDataServer(store = new DataConfigStore()): {
  createServer(): McpServer;
  close(): Promise<void>;
} {
  const mysqlConfig = new MysqlConfigStore(store);
  const mysql = new MysqlDatabaseManager(mysqlConfig);
  const redisConfig = new RedisConfigStore(store);
  const redis = new RedisDatabaseManager(redisConfig);
  const mongoConfig = new MongoConfigStore(store);
  const mongo = new MongoDatabaseManager(mongoConfig);
  return {
    createServer(): McpServer {
      const server = new McpServer({ name: "data-mcp-server", version: VERSION });
      registerMysqlTools(server, mysqlConfig, mysql);
      registerRedisTools(server, redisConfig, redis);
      registerMongoTools(server, mongoConfig, mongo);
      return server;
    },
    close: () => mysql.close(),
  };
}
