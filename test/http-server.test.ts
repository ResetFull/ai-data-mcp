import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { isAuthorized, startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createDataServer } from "../src/server.js";

describe("HTTP bearer authentication", () => {
  it("should_accept_the_exact_bearer_token", () => {
    expect(isAuthorized("Bearer local-secret", "local-secret")).toBe(true);
  });

  it.each([
    undefined,
    "Basic local-secret",
    "Bearer wrong-secret",
    "bearer local-secret",
  ])("should_reject_invalid_authorization_header_%s", (header) => {
    expect(isAuthorized(header, "local-secret")).toBe(false);
  });
});

describe("real loopback HTTP transport", () => {
  const runtime = createDataServer();
  let server: RunningHttpServer;
  beforeAll(async () => { server = await startHttpServer(runtime.createServer, { host: "127.0.0.1", port: 0, token: "synthetic-http-token" }); });
  afterAll(async () => { await server?.close(); await runtime.close(); });

  function send(path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path, method, headers }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.setTimeout(5000, () => req.destroy(new Error("HTTP test deadline")));
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  it("should_return_health_without_credentials_and_omit_head_body", async () => {
    const health = await send("/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ status: "ok", transport: "streamable-http" });
    expect(await send("/health", "HEAD")).toEqual({ status: 200, text: "" });
    expect((await send("/health", "POST")).status).toBe(405);
  });

  it("should_reject_mcp_when_bearer_credentials_are_missing_or_wrong", async () => {
    expect((await send("/mcp", "POST")).status).toBe(401);
    expect((await send("/mcp", "POST", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await send("/unknown")).status).toBe(404);
  });

  it("should_reject_dns_rebinding_and_untrusted_browser_origins", async () => {
    expect((await send("/health", "GET", { Host: "attacker.example.com" })).status).toBe(403);
    expect((await send("/mcp", "POST", { Origin: "https://attacker.example.com", Authorization: "Bearer synthetic-http-token" })).status).toBe(403);
  });

  it("should_discover_the_real_tools_when_http_authentication_succeeds", async () => {
    const response = await send("/mcp", "POST", {
      Authorization: "Bearer synthetic-http-token",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(response.status).toBe(200);
    const data = response.text.startsWith("{") ? response.text : response.text.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice(6);
    const result = JSON.parse(data ?? "{}");
    expect(result.error).toBeUndefined();
    expect(result.result.tools).toHaveLength(18);
    expect(result.result.tools.find((tool: { name: string }) => tool.name === "mysql_execute").inputSchema.properties).toHaveProperty("allow_ddl");
  });
});
