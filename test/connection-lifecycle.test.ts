import { describe, expect, it, vi } from "vitest";
import { withMysqlConnection } from "../src/mysql/connection-lifecycle.js";

function fakeConnection() {
  return {
    release: vi.fn(),
    destroy: vi.fn(),
  };
}

describe("withMysqlConnection", () => {
  it("should_release_connection_when_operation_succeeds", async () => {
    const connection = fakeConnection();

    await withMysqlConnection(connection, async () => "ok");

    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it("should_destroy_connection_when_operation_fails", async () => {
    const connection = fakeConnection();
    const failure = new Error("query timeout");

    await expect(withMysqlConnection(connection, async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("should_await_an_async_release_when_operation_succeeds", async () => {
    let release!: () => void;
    let releaseCalled = false;
    let completed = false;
    const connection = {
      release: vi.fn(() => new Promise<void>((resolve) => {
        releaseCalled = true;
        release = resolve;
      })),
      destroy: vi.fn(),
    };

    const result = withMysqlConnection(connection, async () => "ok").then(() => { completed = true; });
    await Promise.resolve();
    expect(releaseCalled).toBe(true);
    expect(completed).toBe(false);
    release();
    await result;

    expect(completed).toBe(true);
  });

  it("should_destroy_when_success_cleanup_fails", async () => {
    const cleanupFailure = new Error("close failed");
    const connection = {
      release: vi.fn(async () => { throw cleanupFailure; }),
      destroy: vi.fn(),
    };

    await expect(withMysqlConnection(connection, async () => "ok")).rejects.toBe(cleanupFailure);
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
