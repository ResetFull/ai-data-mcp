import { describe, expect, it } from "vitest";
import { analyzeExecutableSql, analyzeReadSql, assertTransactionDml, limitSelectSql } from "../src/mysql/sql-policy.js";

describe("analyzeReadSql", () => {
  it.each([
    "SELECT id FROM users WHERE status = ?",
    "WITH active AS (SELECT id FROM users WHERE active = 1) SELECT * FROM active",
    "SHOW TABLES",
    "DESCRIBE users",
    "EXPLAIN SELECT * FROM users WHERE id = ?",
  ])("should_allow_read_statement_%s", (sql) => {
    expect(() => analyzeReadSql(sql)).not.toThrow();
  });

  it.each([
    "INSERT INTO users(name) VALUES (?)",
    "SELECT * FROM users FOR UPDATE",
    "SELECT * INTO OUTFILE '/tmp/users' FROM users",
    "SELECT SLEEP(10)",
    "SELECT @counter := @counter + 1",
    "SELECT 1; SELECT 2",
  ])("should_reject_unsafe_read_%s", (sql) => {
    expect(() => analyzeReadSql(sql)).toThrow();
  });

  it("should_ignore_prohibited_words_inside_literals_and_comments", () => {
    expect(() => analyzeReadSql("SELECT 'FOR UPDATE' AS label /* SLEEP(10) */")).not.toThrow();
  });
});

describe("write policies", () => {
  it.each([
    ["INSERT INTO users(name) VALUES (?)", "insert"],
    ["UPDATE users SET name = ? WHERE id = ?", "update"],
    ["DELETE FROM users WHERE id = ?", "delete"],
    ["CREATE TABLE sample(id BIGINT PRIMARY KEY)", "create"],
  ])("should_allow_nonprod_execution_%s", (sql, expectedType) => {
    expect(analyzeExecutableSql(sql, { allowDdl: true })).toBe(expectedType);
  });

  it.each(["START TRANSACTION", "COMMIT", "ROLLBACK", "SET autocommit = 0", "USE another_db"])(
    "should_reject_session_control_%s",
    (sql) => expect(() => analyzeExecutableSql(sql)).toThrow(),
  );

  it("should_allow_only_dml_in_managed_transactions", () => {
    expect(assertTransactionDml("INSERT INTO users(name) VALUES (?)")).toBe("insert");
    expect(() => assertTransactionDml("ALTER TABLE users ADD COLUMN note VARCHAR(20)")).toThrow();
  });
});

describe("limitSelectSql", () => {
  it("should_wrap_select_and_request_one_sentinel_row", () => {
    expect(limitSelectSql("SELECT id FROM users;", 200)).toBe("SELECT * FROM (SELECT id FROM users) AS __data_mcp_limited LIMIT 201");
  });
});
