import { timingSafeEqual } from "node:crypto";
import { createServer as createNodeHttpServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { VERSION } from "./version.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

type McpServerFactory = () => McpServer;

export async function startHttpServer(
  createMcpServer: McpServerFactory,
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  const mcpHandler = createMcpHandler(createMcpServer, {
    legacy: "stateless",
    onerror: reportServerError,
  });
  const handleMcpRequest = toNodeHandler(mcpHandler, { onerror: reportServerError }) as unknown as (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createNodeHttpServer((request, response) => {
    void routeRequest(request, response).catch((error: unknown) => {
      reportServerError(toError(error));
      if (!response.headersSent) {
        writeJson(response, 500, { error: "internal_server_error" });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!validateHost(request, response) || !validateOrigin(request, response)) {
      return;
    }

    const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (path === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
        return;
      }
      writeJson(response, 200, {
        status: "ok",
        name: "data-mcp-server",
        version: VERSION,
        transport: "streamable-http",
        pid: process.pid,
        uptime_seconds: Math.floor(process.uptime()),
      }, undefined, request.method === "HEAD");
      return;
    }

    if (path !== "/mcp") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isAuthorized(request.headers.authorization, options.token)) {
      writeJson(response, 401, { error: "unauthorized" }, {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }
    await handleMcpRequest(request, response);
  }

  await listen(server, options.host, options.port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeNodeServer(server);
    throw new Error("Data MCP HTTP server did not expose a TCP address.");
  }

  let closePromise: Promise<void> | undefined;
  return {
    host: options.host,
    port: address.port,
    close(): Promise<void> {
      closePromise ??= closeHttpServer(server, mcpHandler.close);
      return closePromise;
    },
  };
}

export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(authorizationHeader.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
  omitBody = false,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(serialized)),
    ...headers,
  });
  response.end(omitBody ? undefined : serialized);
}

async function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => reject(error);
    server.once("error", handleError);
    server.listen(port, host, () => {
      server.off("error", handleError);
      resolve();
    });
  });
}

async function closeHttpServer(server: NodeHttpServer, closeMcpHandler: () => Promise<void>): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await Promise.all([closeNodeServer(server), closeMcpHandler()]);
}

async function closeNodeServer(server: NodeHttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function reportServerError(error: Error): void {
  process.stderr.write(`[data-mcp] HTTP request failed: ${error.name}\n`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
