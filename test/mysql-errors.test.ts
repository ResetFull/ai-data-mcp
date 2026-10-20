import { describe, expect, it } from "vitest";
import { toMysqlPublicError } from "../src/mysql/errors.js";

describe("toMysqlPublicError", () => {
  it("should_report_a_database_connection_limit_for_a_legacy_pool_error", () => {
    const error = toMysqlPublicError(new Error("No connections available."));

    expect(error.code).toBe("DATABASE_CONNECTION_LIMIT");
  });

  it("should_report_the_database_limit_when_the_server_rejects_a_connection", () => {
    const error = Object.assign(new Error("Too many connections"), { code: "ER_CON_COUNT_ERROR" });

    expect(toMysqlPublicError(error)).toMatchObject({ code: "DATABASE_CONNECTION_LIMIT" });
  });

  it("should_report_a_broken_connection_without_exposing_driver_details", () => {
    const error = Object.assign(new Error("socket closed"), { code: "PROTOCOL_CONNECTION_LOST" });

    expect(toMysqlPublicError(error)).toMatchObject({ code: "CONNECTION_BROKEN" });
  });

  it("should_distinguish_a_connect_timeout_from_a_query_timeout", () => {
    const connectTimeout = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
      syscall: "connect",
    });
    const queryTimeout = Object.assign(new Error("Query inactivity timeout"), {
      code: "PROTOCOL_SEQUENCE_TIMEOUT",
    });

    expect(toMysqlPublicError(connectTimeout)).toMatchObject({ code: "CONNECTION_TIMEOUT" });
    expect(toMysqlPublicError(queryTimeout)).toMatchObject({ code: "QUERY_TIMEOUT" });
  });
});
