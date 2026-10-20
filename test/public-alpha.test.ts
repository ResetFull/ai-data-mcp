import { describe, expect, it } from "vitest";
import { DataMcpConfigSchema } from "../src/config.js";
import { toMysqlPublicError } from "../src/mysql/errors.js";
import { analyzeExecutableSql } from "../src/mysql/sql-policy.js";
import { assertRedisWriteCommand } from "../src/redis/policy.js";
import { assertMongoWriteAllowed } from "../src/mongo/policy.js";
import { success } from "../src/tool-result.js";
import { runWrite } from "../src/write-policy.js";

describe("public Alpha safety defaults", () => {
  it("should_disable_writes_when_configuration_omits_opt_in", () => {
    const config = DataMcpConfigSchema.parse({ redis: { connections: [
      { id: "cache-local", environment: "local", host: "127.0.0.1" },
    ] } });
    expect(config.redis?.connections[0]?.write_enabled).toBe(false);
  });

  it("should_reject_redis_writes_when_nonproduction_has_not_opted_in", () => {
    expect(() => assertRedisWriteCommand(["SET", "demo", "value"], "local")).toThrow(/disabled/i);
    expect(assertRedisWriteCommand(["SET", "demo", "value"], "local", true)).toBe("SET");
    expect(() => assertRedisWriteCommand(["SET", "demo", "value"], "prod", true)).toThrow(/read-only/i);
  });

  it("should_reject_mongo_writes_when_nonproduction_has_not_opted_in", () => {
    expect(() => assertMongoWriteAllowed("test", { id: 1 }, false)).toThrow(/disabled/i);
    expect(() => assertMongoWriteAllowed("test", { id: 1 }, false, true)).not.toThrow();
    expect(() => assertMongoWriteAllowed("prod", { id: 1 }, false, true)).toThrow(/read-only/i);
  });

  it("should_hide_driver_message_when_mysql_reports_duplicate_values", () => {
    const secret = "synthetic-private-value";
    const error = Object.assign(new Error(`Duplicate entry '${secret}' for key 'email'`), { code: "ER_DUP_ENTRY" });
    const result = toMysqlPublicError(error);
    expect(result.code).toBe("DUPLICATE_ENTRY");
    expect(result.message).not.toContain(secret);
    expect(toMysqlPublicError(new Error(secret)).message).not.toContain(secret);
  });

  it("should_require_explicit_flags_when_sql_is_unfiltered_or_ddl", () => {
    expect(() => analyzeExecutableSql("DELETE FROM demo_records")).toThrow(/allow_all/i);
    expect(() => analyzeExecutableSql("UPDATE demo_records SET name = 'demo'")).toThrow(/allow_all/i);
    expect(() => analyzeExecutableSql("DROP TABLE demo_records")).toThrow(/allow_ddl/i);
    expect(analyzeExecutableSql("DELETE FROM demo_records", { allowAll: true })).toBe("delete");
    expect(analyzeExecutableSql("DROP TABLE demo_records", { allowDdl: true })).toBe("drop");
  });

  it("should_reject_oversized_responses_when_one_value_exceeds_the_budget", () => {
    expect(() => success({ result: "x".repeat(100_001) }, "small text")).toThrow(/response/i);
    expect(success({ result: "ok" }, "ok").structuredContent).toEqual({ result: "ok" });
  });

  it("should_report_uncertain_outcome_when_an_inflight_write_loses_its_acknowledgment", async () => {
    const error = Object.assign(new Error("synthetic-private-details"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
    await expect(runWrite(async () => { throw error; })).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    await expect(runWrite(async () => { throw error; })).rejects.not.toThrow(/synthetic-private-details/);
  });
});
