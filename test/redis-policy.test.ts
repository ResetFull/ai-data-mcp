import { describe, expect, it } from "vitest";
import { assertRedisReadCommand, assertRedisWriteCommand } from "../src/redis/policy.js";
import { toRedisClientOptions } from "../src/redis/database.js";

describe("Redis command policy", () => {
  it("should_allow_bounded_read_commands", () => {
    expect(assertRedisReadCommand(["GET", "session:1"])).toBe("GET");
    expect(assertRedisReadCommand(["HSCAN", "profile:1", "0", "COUNT", "20"])).toBe("HSCAN");
  });

  it("should_reject_expensive_or_mutating_commands_from_read_tool", () => {
    expect(() => assertRedisReadCommand(["KEYS", "*"])).toThrow(/not allowed/i);
    expect(() => assertRedisReadCommand(["HGETALL", "profile:1"])).toThrow(/not allowed/i);
    expect(() => assertRedisReadCommand(["LRANGE", "events", "0", "-1"])).toThrow(/at most 500/i);
    expect(() => assertRedisReadCommand(["XRANGE", "events", "-", "+"])).toThrow(/requires COUNT/i);
    expect(() => assertRedisReadCommand(["SET", "session:1", "value"])).toThrow(/not allowed/i);
  });

  it("should_reject_all_writes_for_production_connections", () => {
    expect(() => assertRedisWriteCommand(["DEL", "session:1"], "prod")).toThrow(/read-only/i);
    expect(assertRedisWriteCommand(["SET", "session:1", "value"], "test", true)).toBe("SET");
  });

  it("should_preserve_password_only_authentication_for_legacy_redis", () => {
    expect(toRedisClientOptions({
      id: "cache-dev",
      environment: "dev",
      host: "redis.internal",
      port: 6379,
      database: 0,
      tls: false,
      connectTimeoutMs: 10000,
    }, "p@ss")).toMatchObject({ RESP: 2, password: "p@ss", database: 0 });
    expect(toRedisClientOptions({
      id: "cache-dev",
      environment: "dev",
      host: "redis.internal",
      port: 6379,
      database: 0,
      tls: false,
      connectTimeoutMs: 10000,
    }, "p@ss")).not.toHaveProperty("username");
  });
});
