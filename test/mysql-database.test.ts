import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Connection } from "mysql2/promise";
import { MysqlConnectionMiddleware } from "../src/mysql/connection-middleware.js";
import type { MysqlConnectionConfig } from "../src/mysql/config.js";
import { MysqlDatabaseManager } from "../src/mysql/database.js";

const connectionConfig: MysqlConnectionConfig = {
  id: "test-main",
  environment: "test",
  write_enabled: false,
  host: "mysql.internal",
  port: 3306,
  database: "business_db",
  user: "codex_rw",
  ssl: false,
  connectionLimit: 0,
  connectTimeoutMs: 10000,
};

function fakeConnection(): Connection {
  return {
    end: vi.fn(async () => undefined),
    destroy: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Connection;
}

function eventfulConnection(): Connection & EventEmitter {
  const connection = new EventEmitter() as Connection & EventEmitter;
  connection.end = vi.fn(async () => undefined);
  connection.destroy = vi.fn();
  return connection;
}

describe("MysqlConnectionMiddleware", () => {
  it("should_reuse_a_healthy_idle_connection_for_sequential_operations", async () => {
    const connection = fakeConnection();
    const factory = vi.fn(async () => connection);
    const middleware = new MysqlConnectionMiddleware(factory);

    const first = await middleware.run(connectionConfig, "secret", async (active) => active);
    const second = await middleware.run(connectionConfig, "secret", async (active) => active);

    expect(factory).toHaveBeenCalledOnce();
    expect(first).toBe(connection);
    expect(second).toBe(connection);
    expect(connection.end).not.toHaveBeenCalled();
    expect(connection.destroy).not.toHaveBeenCalled();

    await middleware.close();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("should_destroy_a_connection_when_the_operation_fails", async () => {
    const connection = fakeConnection();
    const failure = new Error("query timeout");
    const middleware = new MysqlConnectionMiddleware(async () => connection);

    await expect(middleware.run(connectionConfig, "secret", async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.end).not.toHaveBeenCalled();
  });

  it("should_remove_an_idle_connection_when_the_driver_reports_an_error", async () => {
    const broken = eventfulConnection();
    const replacement = fakeConnection();
    const factory = vi.fn()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(replacement);
    const middleware = new MysqlConnectionMiddleware(factory);

    await middleware.run(connectionConfig, "secret", async (connection) => connection);
    broken.emit("error", new Error("socket closed"));
    const active = await middleware.run(connectionConfig, "secret", async (connection) => connection);

    expect(active).toBe(replacement);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(broken.destroy).toHaveBeenCalledOnce();
    await middleware.close();
  });

  it("should_open_independent_connections_without_using_a_pool_limit", async () => {
    const connections = [fakeConnection(), fakeConnection(), fakeConnection()];
    let nextConnection = 0;
    const factory = vi.fn(async () => connections[nextConnection++] as Connection);
    const firstOperation = deferred<void>();
    const middleware = new MysqlConnectionMiddleware(factory, {
      handshakeConcurrencyLimit: 1,
      acquisitionTimeoutMs: 1000,
    });

    const first = middleware.run(connectionConfig, "secret", async () => firstOperation.promise);
    await waitFor(() => factory.mock.calls.length === 1);
    const second = middleware.run(connectionConfig, "secret", async () => "two");
    await waitFor(() => factory.mock.calls.length === 2);

    firstOperation.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, "two"]);
    expect(factory).toHaveBeenCalledTimes(2);
    await middleware.close();
  });

  it("should_limit_only_physical_handshakes_while_reusing_connections", async () => {
    const connections = [fakeConnection(), fakeConnection(), fakeConnection(), fakeConnection(), fakeConnection()];
    const handshakeGate = deferred<void>();
    let activeHandshakes = 0;
    let maximumHandshakes = 0;
    let nextConnection = 0;
    const factory = vi.fn(async () => {
      activeHandshakes += 1;
      maximumHandshakes = Math.max(maximumHandshakes, activeHandshakes);
      await handshakeGate.promise;
      activeHandshakes -= 1;
      return connections[nextConnection++];
    });
    const middleware = new MysqlConnectionMiddleware(factory, {
      handshakeConcurrencyLimit: 2,
      acquisitionTimeoutMs: 1000,
    });

    const operations = [1, 2, 3, 4, 5].map((value) => middleware.run(connectionConfig, "secret", async () => value));
    await waitFor(() => factory.mock.calls.length === 2);
    expect(maximumHandshakes).toBe(2);

    handshakeGate.resolve();
    await expect(Promise.all(operations)).resolves.toEqual([1, 2, 3, 4, 5]);
    expect(factory.mock.calls.length).toBeLessThanOrEqual(5);
    await middleware.close();
  });

  it("should_keep_a_timed_out_physical_handshake_counted_until_factory_settles", async () => {
    const connection = fakeConnection();
    const handshake = deferred<Connection>();
    const factory = vi.fn(async () => handshake.promise);
    const middleware = new MysqlConnectionMiddleware(factory, {
      handshakeConcurrencyLimit: 1,
      acquisitionTimeoutMs: 20,
    });
    const shortConnectConfig = { ...connectionConfig, connectTimeoutMs: 1000 };

    await expect(middleware.run(shortConnectConfig, "secret", async () => "never"))
      .rejects.toMatchObject({ code: "CONNECTION_TIMEOUT" });

    await expect(middleware.run(shortConnectConfig, "secret", async () => "waiting"))
      .rejects.toMatchObject({ code: "CONNECTION_TIMEOUT" });
    expect(factory).toHaveBeenCalledOnce();

    let closed = false;
    const closing = middleware.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    handshake.resolve(connection);
    await closing;
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("should_cancel_a_waiting_acquisition_without_leaving_a_ghost_request", async () => {
    const connection = fakeConnection();
    const handshakeGate = deferred<void>();
    const factory = vi.fn(async () => {
      await handshakeGate.promise;
      return connection;
    });
    const middleware = new MysqlConnectionMiddleware(factory, {
      handshakeConcurrencyLimit: 1,
      acquisitionTimeoutMs: 10,
    });

    const first = middleware.run(connectionConfig, "secret", async () => "first");
    await waitFor(() => factory.mock.calls.length === 1);
    const waiting = middleware.run(connectionConfig, "secret", async () => "waiting");
    await expect(waiting).rejects.toMatchObject({ code: "CONNECTION_TIMEOUT" });

    const closing = middleware.close();
    handshakeGate.resolve();
    await closing;
    await expect(first).rejects.toMatchObject({ code: "MYSQL_MIDDLEWARE_CLOSED" });
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.end).not.toHaveBeenCalled();
  });

  it("should_drain_an_in_flight_handshake_before_close_resolves", async () => {
    const connection = fakeConnection();
    const handshakeGate = deferred<void>();
    const factory = vi.fn(async () => {
      await handshakeGate.promise;
      return connection;
    });
    const middleware = new MysqlConnectionMiddleware(factory, { acquisitionTimeoutMs: 1000 });
    const running = middleware.run(connectionConfig, "secret", async () => "never");
    await waitFor(() => factory.mock.calls.length === 1);

    let closed = false;
    const closing = middleware.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    handshakeGate.resolve();
    await expect(running).rejects.toMatchObject({ code: "MYSQL_MIDDLEWARE_CLOSED" });
    await closing;
    expect(closed).toBe(true);
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("should_report_closed_when_an_in_flight_handshake_fails_during_close", async () => {
    const handshake = deferred<Connection>();
    const factory = vi.fn(async () => handshake.promise);
    const middleware = new MysqlConnectionMiddleware(factory);
    const running = middleware.run(connectionConfig, "secret", async () => "never");
    await waitFor(() => factory.mock.calls.length === 1);

    const closing = middleware.close();
    handshake.reject(new Error("connect failed"));

    await expect(running).rejects.toMatchObject({ code: "MYSQL_MIDDLEWARE_CLOSED" });
    await closing;
  });

  it("should_evict_idle_connections_after_the_configured_timeout", async () => {
    const connection = fakeConnection();
    const middleware = new MysqlConnectionMiddleware(async () => connection, {
      idleTimeoutMs: 20,
      sweepIntervalMs: 5,
    });

    await middleware.run(connectionConfig, "secret", async () => "ok");
    await waitFor(() => connection.end.mock.calls.length === 1, 200);

    expect(connection.destroy).not.toHaveBeenCalled();
    await middleware.close();
  });

  it("should_destroy_a_connection_when_graceful_idle_close_fails", async () => {
    const connection = fakeConnection();
    connection.end = vi.fn(async () => { throw new Error("close failed"); }) as never;
    const middleware = new MysqlConnectionMiddleware(async () => connection);

    await middleware.run(connectionConfig, "secret", async () => "ok");
    await middleware.close();

    expect(connection.end).toHaveBeenCalledOnce();
    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("should_destroy_active_connections_when_the_middleware_closes", async () => {
    const connection = fakeConnection();
    const factory = vi.fn(async () => connection);
    let finishOperation!: () => void;
    let operationStarted = false;
    const runningOperation = new Promise<void>((resolve) => { finishOperation = resolve; });
    const middleware = new MysqlConnectionMiddleware(factory);
    const running = middleware.run(connectionConfig, "secret", async () => {
      operationStarted = true;
      return runningOperation;
    });

    await waitFor(() => operationStarted);
    await middleware.close();
    expect(connection.destroy).toHaveBeenCalledOnce();

    finishOperation();
    await running;
    expect(connection.end).not.toHaveBeenCalled();
  });
});

describe("MysqlDatabaseManager", () => {
  it("should_reject_writes_before_connecting_when_opt_in_is_missing_or_production_is_configured", async () => {
    for (const config of [connectionConfig, { ...connectionConfig, environment: "prod", write_enabled: true }]) {
      const factory = vi.fn();
      const store = { getConnection: async () => config, getPassword: async () => "synthetic-secret" };
      const manager = new MysqlDatabaseManager(store as never, factory);
      await expect(manager.execute("test-main", "INSERT INTO demo(id) VALUES (?)", [1], 1000)).rejects.toMatchObject({
        code: config.environment === "prod" ? "PRODUCTION_WRITE_REJECTED" : "WRITE_DISABLED",
      });
      expect(factory).not.toHaveBeenCalled();
      await manager.close();
    }
  });
  it("should_run_a_query_through_one_owned_connection_without_pool_options", async () => {
    const connection = fakeConnection();
    const query = vi.fn(async (options: { sql: string }) => {
      if (options.sql.startsWith("SELECT * FROM")) {
        return [[{ value: 1 }], [{ name: "value" }]];
      }
      return [[], []];
    });
    connection.query = query as never;
    const configStore = {
      getConnection: vi.fn(async () => connectionConfig),
      getPassword: vi.fn(async () => "secret"),
    };
    const factory = vi.fn(async (options: Record<string, unknown>) => {
      expect(options).not.toHaveProperty("connectionLimit");
      expect(options).not.toHaveProperty("waitForConnections");
      return connection;
    });
    const manager = new MysqlDatabaseManager(configStore as never, factory);

    const result = await manager.query("test-main", "SELECT 1", [], 10, 1000);

    expect(result.rows).toEqual([{ value: 1 }]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(connection.end).not.toHaveBeenCalled();
    await manager.close();
    expect(connection.end).toHaveBeenCalledOnce();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
