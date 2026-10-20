import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "redis";
import { RedisDatabaseManager } from "../src/redis/database.js";

vi.mock("redis", () => ({ createClient: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  let open = false;
  const client = {
    get isOpen() { return open; },
    on: vi.fn(),
    connect: vi.fn(async () => { open = true; }),
    sendCommand: vi.fn(async () => "PONG"),
    quit: vi.fn(async () => { open = false; }),
    destroy: vi.fn(() => { if (!open) throw new Error("Client is closed"); open = false; }),
  };
  vi.mocked(createClient).mockReturnValue(client as never);
  const configuration = { id: "cache-local", environment: "local", host: "127.0.0.1", port: 1, database: 0, tls: false, connectTimeoutMs: 1000, write_enabled: true };
  const store = { getConnection: async () => configuration, getPassword: async () => undefined };
  return { client, manager: new RedisDatabaseManager(store as never) };
}

describe("Redis operation lifecycle", () => {
  it("should_preserve_success_when_quit_has_already_closed_the_client", async () => {
    const { client, manager } = fixture();
    await expect(manager.command("cache-local", ["PING"])).resolves.toBe("PONG");
    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("should_close_the_socket_and_report_uncertainty_when_a_write_exceeds_its_deadline", async () => {
    vi.useFakeTimers();
    const { client, manager } = fixture();
    client.sendCommand.mockImplementation(() => new Promise(() => {}));
    const operation = manager.command("cache-local", ["SET", "demo", "value"], true);
    const result = operation.catch(error => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
