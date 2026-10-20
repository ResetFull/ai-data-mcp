import { describe, expect, it } from "vitest";
import { DataMcpConfigSchema, DataMcpSecretsSchema } from "../src/config.js";
import { MysqlConnectionConfigSchema } from "../src/mysql/config.js";

describe("MysqlConnectionConfigSchema", () => {
  it("should_default_safe_connection_values_when_optional_fields_are_missing", () => {
    const parsed = MysqlConnectionConfigSchema.parse({
      id: "prod-main",
      environment: "prod",
      host: "mysql.internal",
      database: "business_db",
      user: "codex_ro",
    });

    expect(parsed).toMatchObject({ port: 3306, ssl: false, connectionLimit: 0, connectTimeoutMs: 10000 });
  });

  it("should_accept_legacy_zero_connection_limit_for_per_call_mysql_connections", () => {
    const parsed = MysqlConnectionConfigSchema.parse({
      id: "prod-main",
      environment: "prod",
      host: "mysql.internal",
      database: "business_db",
      user: "codex_ro",
      connectionLimit: 0,
    });

    expect(parsed.connectionLimit).toBe(0);
  });

  it("should_reject_unknown_environment_when_it_could_bypass_prod_policy", () => {
    expect(() => MysqlConnectionConfigSchema.parse({
      id: "production-main",
      environment: "production",
      host: "mysql.internal",
      database: "business_db",
      user: "codex_ro",
    })).toThrow();
  });

  it("should_namespace_mysql_configuration_for_future_providers", () => {
    expect(DataMcpConfigSchema.parse({
      mysql: {
        connections: [{
          id: "test-main",
          environment: "test",
          host: "mysql.internal",
          database: "business_db",
          user: "codex_rw",
        }],
      },
    }).mysql.connections).toHaveLength(1);

    expect(DataMcpSecretsSchema.parse({ mysql: { "test-main": { password: "secret" } } }).mysql["test-main"]?.password).toBe("secret");
  });

  it("should_accept_redis_and_mongo_provider_configuration", () => {
    const parsed = DataMcpConfigSchema.parse({
      mysql: {
        connections: [{
          id: "test-main",
          environment: "test",
          host: "mysql.internal",
          database: "business_db",
          user: "codex_rw",
        }],
      },
      redis: {
        connections: [{
          id: "cache-dev",
          environment: "dev",
          host: "redis.internal",
          database: 2,
        }],
      },
      mongo: {
        connections: [{
          id: "document-test",
          environment: "test",
          database: "documents",
        }],
      },
    });

    expect(parsed.redis?.connections[0]).toMatchObject({ port: 6379, database: 2, tls: false });
    expect(parsed.mongo?.connections[0]).toMatchObject({ database: "documents", maxPoolSize: 5 });
    expect(DataMcpSecretsSchema.parse({
      mysql: { "test-main": { password: "mysql-secret" } },
      redis: { "cache-dev": { password: "redis-secret" } },
      mongo: { "document-test": { uri: "mongodb://user:secret@mongo.internal/documents" } },
    }).mongo?.["document-test"]?.uri).toContain("mongodb://");
  });

  it("should_reject_duplicate_connection_ids_within_each_provider", () => {
    expect(() => DataMcpConfigSchema.parse({
      redis: {
        connections: [
          { id: "cache-dev", environment: "dev", host: "redis-a.internal" },
          { id: "cache-dev", environment: "test", host: "redis-b.internal" },
        ],
      },
    })).toThrow(/duplicate connection id/i);
  });
});
